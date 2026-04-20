"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
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
  fields: PydanticField[],
  versionBump?: { major: number; minor: number; patch: number },
) {
  const supabase = await createSupabaseServer();
  const hash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 16);

  // Fetch previous schema (hash + fields with per-field hashes)
  const { data: project } = await supabase
    .from("projects")
    .select("pydantic_hash, pydantic_fields")
    .eq("id", projectId)
    .single();

  const updatePayload: Record<string, unknown> = {
    pydantic_code: code,
    pydantic_hash: hash,
    pydantic_fields: fields,
  };
  if (versionBump) {
    updatePayload.schema_version_major = versionBump.major;
    updatePayload.schema_version_minor = versionBump.minor;
    updatePayload.schema_version_patch = versionBump.patch;
  }

  const { error } = await supabase
    .from("projects")
    .update(updatePayload)
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

  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/reviews`);
  revalidatePath(`/projects/${projectId}/config/llm`);
  revalidateTag(`project-${projectId}-progress`, { expire: 60 });
}

export async function savePrompt(projectId: string, promptTemplate: string) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("projects")
    .update({ prompt_template: promptTemplate })
    .eq("id", projectId);

  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/config/llm`);
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

// ---------- Versionamento semver ----------

type ChangeType = "major" | "minor" | "patch";

// Classifica uma edição de schema:
// - PATCH: mudanças apenas em description/help_text ou reordenação (sem mudança estrutural)
// - MINOR: adicionar/remover campo, adicionar/remover opção, mudar type/target/required
// - Retorna null quando não há mudança alguma.
function classifyChange(
  oldFields: PydanticField[],
  newFields: PydanticField[],
): ChangeType | null {
  const oldNames = new Set(oldFields.map((f) => f.name));
  const newNames = new Set(newFields.map((f) => f.name));

  const addedOrRemoved =
    newFields.some((f) => !oldNames.has(f.name)) ||
    oldFields.some((f) => !newNames.has(f.name));

  if (addedOrRemoved) return "minor";

  let hasStructural = false;
  let hasTextual = false;

  const oldMap = new Map(oldFields.map((f) => [f.name, f]));
  for (const n of newFields) {
    const o = oldMap.get(n.name);
    if (!o) continue;

    if (o.type !== n.type) hasStructural = true;
    if ((o.target ?? "all") !== (n.target ?? "all")) hasStructural = true;
    if ((o.required ?? true) !== (n.required ?? true)) hasStructural = true;

    const optsOld = o.options ?? [];
    const optsNew = n.options ?? [];
    const setOld = new Set(optsOld);
    const setNew = new Set(optsNew);
    const sameSet =
      setOld.size === setNew.size && [...setOld].every((x) => setNew.has(x));
    if (!sameSet) {
      hasStructural = true;
    } else if (optsOld.length !== optsNew.length) {
      hasStructural = true;
    } else {
      for (let i = 0; i < optsOld.length; i++) {
        if (optsOld[i] !== optsNew[i]) {
          hasTextual = true;
          break;
        }
      }
    }

    if (o.description !== n.description) hasTextual = true;
    if ((o.help_text || "") !== (n.help_text || "")) hasTextual = true;
  }

  // Reordenação da lista de campos conta como PATCH
  if (!hasStructural && !hasTextual) {
    for (let i = 0; i < newFields.length; i++) {
      if (newFields[i].name !== oldFields[i]?.name) {
        hasTextual = true;
        break;
      }
    }
  }

  if (hasStructural) return "minor";
  if (hasTextual) return "patch";
  return null;
}

function bumpVersion(
  current: { major: number; minor: number; patch: number },
  type: ChangeType,
): { major: number; minor: number; patch: number } {
  if (type === "major") {
    return { major: current.major + 1, minor: 0, patch: 0 };
  }
  if (type === "minor") {
    return { major: current.major, minor: current.minor + 1, patch: 0 };
  }
  return { major: current.major, minor: current.minor, patch: current.patch + 1 };
}

// ---------- Save from GUI ----------

export async function saveSchemaFromGUI(
  projectId: string,
  fields: PydanticField[]
) {
  const supabase = await createSupabaseServer();
  const user = await getAuthUser();

  // Fetch old fields + current version
  const { data: project } = await supabase
    .from("projects")
    .select(
      "pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch",
    )
    .eq("id", projectId)
    .single();

  const oldFields = (project?.pydantic_fields as PydanticField[]) || [];
  const oldMap = new Map(oldFields.map((f) => [f.name, f]));

  const current = {
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  };

  const changeType = classifyChange(oldFields, fields);
  const bumped = changeType ? bumpVersion(current, changeType) : current;

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

  // Save schema com versão bumpada (ou mantida se não houve mudança)
  const { generatePydanticCode } = await import("@/lib/schema-utils");
  const code = generatePydanticCode(fields);
  const fieldsWithHash = fields.map((f) => ({
    ...f,
    hash: computeFieldHash(f.name, f.type, f.options, f.description),
  }));
  await saveSchema(projectId, code, fieldsWithHash, changeType ? bumped : undefined);

  // Insert audit log entries com change_type + versão alvo
  if (logEntries.length > 0 && user) {
    await supabase.from("schema_change_log").insert(
      logEntries.map((e) => ({
        project_id: projectId,
        changed_by: user.id,
        change_type: changeType ?? "patch",
        version_major: bumped.major,
        version_minor: bumped.minor,
        version_patch: bumped.patch,
        ...e,
      })),
    );
  }
}

// ---------- MAJOR version bump (manual) ----------

export async function publishMajorVersion(projectId: string) {
  const supabase = await createSupabaseServer();
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const { data: project } = await supabase
    .from("projects")
    .select(
      "schema_version_major, schema_version_minor, schema_version_patch",
    )
    .eq("id", projectId)
    .single();

  const current = {
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  };
  const bumped = bumpVersion(current, "major");

  const { error } = await supabase
    .from("projects")
    .update({
      schema_version_major: bumped.major,
      schema_version_minor: bumped.minor,
      schema_version_patch: bumped.patch,
    })
    .eq("id", projectId);

  if (error) throw new Error(error.message);

  await supabase.from("schema_change_log").insert({
    project_id: projectId,
    changed_by: user.id,
    field_name: "(projeto)",
    change_summary: `Nova versão MAJOR publicada: ${bumped.major}.${bumped.minor}.${bumped.patch}`,
    before_value: current as unknown as Record<string, unknown>,
    after_value: bumped as unknown as Record<string, unknown>,
    change_type: "major",
    version_major: bumped.major,
    version_minor: bumped.minor,
    version_patch: bumped.patch,
  });

  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/reviews`);
  revalidatePath(`/projects/${projectId}/config/llm`);
  return bumped;
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
  revalidatePath(`/projects/${projectId}/config/llm`);
  revalidatePath(`/projects/${projectId}/config`);
}
