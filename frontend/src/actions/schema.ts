"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { fetchFastAPI } from "@/lib/api";
import type { PydanticField } from "@/lib/types";
import crypto from "crypto";

interface ValidateResponse {
  valid: boolean;
  fields: PydanticField[];
  model_name: string | null;
  errors: string[];
}

export async function validateSchema(code: string): Promise<ValidateResponse> {
  return fetchFastAPI<ValidateResponse>("/api/pydantic/validate", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function saveSchema(
  projectId: string,
  code: string,
  fields: PydanticField[]
) {
  const supabase = await createSupabaseServer();
  const hash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 16);

  // Check if hash changed -> invalidate LLM responses
  const { data: project } = await supabase
    .from("projects")
    .select("pydantic_hash")
    .eq("id", projectId)
    .single();

  const { error } = await supabase
    .from("projects")
    .update({
      pydantic_code: code,
      pydantic_hash: hash,
      pydantic_fields: fields,
    })
    .eq("id", projectId);

  if (error) throw new Error(error.message);

  // Invalidate old LLM responses if hash changed
  if (project?.pydantic_hash && project.pydantic_hash !== hash) {
    await supabase
      .from("responses")
      .update({ is_current: false })
      .eq("project_id", projectId)
      .eq("respondent_type", "llm")
      .neq("pydantic_hash", hash);
  }

  revalidatePath(`/projects/${projectId}`);
}

export async function savePrompt(projectId: string, promptTemplate: string) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("projects")
    .update({ prompt_template: promptTemplate })
    .eq("id", projectId);

  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}`);
}

export async function saveLlmConfig(
  projectId: string,
  config: {
    llm_provider: string;
    llm_model: string;
    llm_kwargs: Record<string, unknown>;
  }
) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("projects")
    .update(config)
    .eq("id", projectId);

  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}`);
}
