"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath, revalidateTag } from "next/cache";
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

  // Human answers are no longer deleted when fields change.
  // Staleness is detected at display time via answer_field_hashes.

  revalidatePath(`/projects/${projectId}/code`);
  revalidatePath(`/projects/${projectId}/compare`);
  revalidatePath(`/projects/${projectId}/reviews`);
  revalidatePath(`/projects/${projectId}/llm`);
  revalidateTag(`project-${projectId}-progress`, { expire: 60 });
}

export async function savePrompt(projectId: string, promptTemplate: string) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("projects")
    .update({ prompt_template: promptTemplate })
    .eq("id", projectId);

  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}/code`);
  revalidatePath(`/projects/${projectId}/llm`);
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
  const supabase = await createSupabaseServer();

  // Fetch old fields + user for audit log
  const [{ data: project }, { data: { user } }] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", projectId)
      .single(),
    supabase.auth.getUser(),
  ]);

  const oldFields = (project?.pydantic_fields as PydanticField[]) || [];
  const oldMap = new Map(oldFields.map((f) => [f.name, f]));

  // Detect per-field changes and build log entries
  const logEntries: {
    field_name: string;
    change_summary: string;
    before_value: Record<string, unknown>;
    after_value: Record<string, unknown>;
  }[] = [];

  for (const f of fields) {
    const old = oldMap.get(f.name);
    if (!old) continue;
    const diffs: string[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (old.description !== f.description) {
      diffs.push("descrição");
      before.description = old.description;
      after.description = f.description;
    }
    if ((old.help_text || "") !== (f.help_text || "")) {
      diffs.push("instruções");
      before.help_text = old.help_text || null;
      after.help_text = f.help_text || null;
    }
    const oldOpts = JSON.stringify(old.options ?? null);
    const newOpts = JSON.stringify(f.options ?? null);
    if (oldOpts !== newOpts) {
      diffs.push(f.type === "text" ? "respostas padronizadas" : "opções");
      before.options = old.options;
      after.options = f.options;
    }

    if (diffs.length > 0) {
      logEntries.push({
        field_name: f.name,
        change_summary: diffs.join(", "),
        before_value: before,
        after_value: after,
      });
    }
  }

  // Save schema
  const { generatePydanticCode } = await import("@/lib/schema-utils");
  const code = generatePydanticCode(fields);
  const fieldsWithHash = fields.map((f) => ({
    ...f,
    hash: computeFieldHash(f.name, f.type, f.options, f.description),
  }));
  await saveSchema(projectId, code, fieldsWithHash);

  // Insert audit log entries
  if (logEntries.length > 0 && user) {
    await supabase.from("schema_change_log").insert(
      logEntries.map((e) => ({
        project_id: projectId,
        changed_by: user.id,
        ...e,
      })),
    );
  }
}

export async function toggleLlmField(
  projectId: string,
  fieldDef: PydanticField,
  enabled: boolean
) {
  const supabase = await createSupabaseServer();
  const { data: project } = await supabase
    .from("projects")
    .select("pydantic_fields")
    .eq("id", projectId)
    .single();

  let fields = (project?.pydantic_fields as PydanticField[]) || [];

  if (enabled) {
    if (!fields.some((f) => f.name === fieldDef.name)) {
      fields = [...fields, fieldDef];
    }
  } else {
    fields = fields.filter((f) => f.name !== fieldDef.name);
  }

  await saveSchemaFromGUI(projectId, fields);
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
  revalidatePath(`/projects/${projectId}/llm`);
  revalidatePath(`/projects/${projectId}/config`);
}
