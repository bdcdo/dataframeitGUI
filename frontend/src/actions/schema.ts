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

  // Fetch previous schema (hash + fields with per-field hashes)
  const { data: project } = await supabase
    .from("projects")
    .select("pydantic_hash, pydantic_fields")
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

  // Surgical invalidation: clear human answers for changed/removed fields
  if (project?.pydantic_fields) {
    const oldFields = project.pydantic_fields as PydanticField[];
    const oldHashMap = new Map(oldFields.map((f) => [f.name, f.hash]));

    const changedFields: string[] = [];
    for (const field of fields) {
      const oldHash = oldHashMap.get(field.name);
      if (oldHash && oldHash !== field.hash) {
        changedFields.push(field.name);
      }
    }
    // Removed fields
    const newNames = new Set(fields.map((f) => f.name));
    for (const oldField of oldFields) {
      if (!newNames.has(oldField.name)) {
        changedFields.push(oldField.name);
      }
    }

    for (const fieldName of changedFields) {
      await supabase.rpc("remove_answer_key", {
        p_project_id: projectId,
        p_field_name: fieldName,
      });
    }
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

// ---------- Hash por campo (reproduz backend _field_hash) ----------

function pythonListRepr(arr: string[]): string {
  return "[" + arr.map((s) => `'${s}'`).join(", ") + "]";
}

function computeFieldHash(
  name: string,
  type: string,
  options: string[] | null,
  description: string
): string {
  const optionsPart = options ? pythonListRepr([...options].sort()) : "";
  const content = `${name}|${type}|${optionsPart}|${description}`;
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
}

// ---------- Save from GUI ----------

export async function saveSchemaFromGUI(
  projectId: string,
  fields: PydanticField[]
) {
  const { generatePydanticCode } = await import("@/lib/schema-utils");
  const code = generatePydanticCode(fields);
  const fieldsWithHash = fields.map((f) => ({
    ...f,
    hash: computeFieldHash(f.name, f.type, f.options, f.description),
  }));
  return saveSchema(projectId, code, fieldsWithHash);
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
