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
    if ((o.subfield_rule ?? null) !== (n.subfield_rule ?? null)) hasStructural = true;
    if ((o.allow_other ?? false) !== (n.allow_other ?? false)) hasStructural = true;
    if (JSON.stringify(o.subfields ?? null) !== JSON.stringify(n.subfields ?? null)) {
      hasStructural = true;
    }
    if (JSON.stringify(o.condition ?? null) !== JSON.stringify(n.condition ?? null)) {
      hasStructural = true;
    }

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

// Classifica um diff de schema_change_log (before/after por campo) como estrutural (minor)
// ou textual (patch). Add/remove são sempre estruturais.
function fieldDiffIsStructural(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  if (Object.keys(before).length === 0 || Object.keys(after).length === 0) return true;

  for (const k of ["type", "target", "required", "subfield_rule", "allow_other"]) {
    if (before[k] !== undefined || after[k] !== undefined) return true;
  }

  if (before.subfields !== undefined || after.subfields !== undefined) {
    if (JSON.stringify(before.subfields ?? null) !== JSON.stringify(after.subfields ?? null)) {
      return true;
    }
  }

  if (before.condition !== undefined || after.condition !== undefined) {
    if (JSON.stringify(before.condition ?? null) !== JSON.stringify(after.condition ?? null)) {
      return true;
    }
  }

  const bOpts = before.options;
  const aOpts = after.options;
  if (bOpts !== undefined || aOpts !== undefined) {
    const bArr = Array.isArray(bOpts) ? (bOpts as unknown[]) : [];
    const aArr = Array.isArray(aOpts) ? (aOpts as unknown[]) : [];
    const bSet = new Set(bArr);
    const aSet = new Set(aArr);
    const sameSet = bSet.size === aSet.size && [...bSet].every((x) => aSet.has(x));
    if (!sameSet) return true;
  }
  return false;
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

  const newMap = new Map(fields.map((f) => [f.name, f]));

  function snapshotOf(field: PydanticField): Record<string, unknown> {
    return {
      name: field.name,
      type: field.type,
      description: field.description,
      help_text: field.help_text ?? null,
      options: field.options ?? null,
      target: field.target ?? null,
      required: field.required ?? null,
      subfields: field.subfields ?? null,
      subfield_rule: field.subfield_rule ?? null,
      allow_other: field.allow_other ?? null,
      condition: field.condition ?? null,
    };
  }

  // Campos adicionados: sem entry anterior
  for (const f of fields) {
    if (oldMap.has(f.name)) continue;
    logEntries.push({
      field_name: f.name,
      change_summary: "campo adicionado",
      before_value: {},
      after_value: snapshotOf(f),
    });
  }

  // Campos removidos: sem entry atual
  for (const o of oldFields) {
    if (newMap.has(o.name)) continue;
    logEntries.push({
      field_name: o.name,
      change_summary: "campo removido",
      before_value: snapshotOf(o),
      after_value: {},
    });
  }

  // Campos modificados: compara atributo por atributo
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
    if (old.type !== f.type) {
      diffs.push("tipo");
      before.type = old.type;
      after.type = f.type;
    }
    if ((old.target ?? "all") !== (f.target ?? "all")) {
      diffs.push("alvo");
      before.target = old.target ?? null;
      after.target = f.target ?? null;
    }
    if ((old.required ?? true) !== (f.required ?? true)) {
      diffs.push("obrigatório");
      before.required = old.required ?? null;
      after.required = f.required ?? null;
    }
    if ((old.subfield_rule ?? null) !== (f.subfield_rule ?? null)) {
      diffs.push("regra de subcampos");
      before.subfield_rule = old.subfield_rule ?? null;
      after.subfield_rule = f.subfield_rule ?? null;
    }
    if ((old.allow_other ?? false) !== (f.allow_other ?? false)) {
      diffs.push("permite outro");
      before.allow_other = old.allow_other ?? false;
      after.allow_other = f.allow_other ?? false;
    }
    const oldSubs = JSON.stringify(old.subfields ?? null);
    const newSubs = JSON.stringify(f.subfields ?? null);
    if (oldSubs !== newSubs) {
      diffs.push("subcampos");
      before.subfields = old.subfields ?? null;
      after.subfields = f.subfields ?? null;
    }
    const oldCond = JSON.stringify(old.condition ?? null);
    const newCond = JSON.stringify(f.condition ?? null);
    if (oldCond !== newCond) {
      diffs.push("condição");
      before.condition = old.condition ?? null;
      after.condition = f.condition ?? null;
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

// ---------- Backfill retroativo usando schema_change_log ----------
// Reconstrói a versão do projeto a partir do histórico já registrado.
// - Classifica entries não classificadas (minor/patch), respeita majors já setados.
// - Reconstrói snapshots do schema em cada versão (reverter diffs do atual).
// - Atribui versão a cada resposta usando answer_field_hashes quando disponível;
//   cai em created_at quando não (responses pré-hash).
// - Rastreia o método em responses.version_inferred_from.
// Idempotente.

type FieldSnapshot = Partial<PydanticField> & { name: string };

function cloneFieldSnapshot(f: FieldSnapshot): FieldSnapshot {
  return {
    ...f,
    options: f.options ? [...f.options] : f.options,
  };
}

function cloneSnapshotMap(snap: Map<string, FieldSnapshot>): Map<string, FieldSnapshot> {
  const out = new Map<string, FieldSnapshot>();
  for (const [k, v] of snap) out.set(k, cloneFieldSnapshot(v));
  return out;
}

function versionKey(v: { major: number; minor: number; patch: number }) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function computeHashesFromSnapshot(snap: Map<string, FieldSnapshot>): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const [name, field] of snap) {
    if (!field.type || field.description == null) continue;
    hashes[name] = computeFieldHash(
      name,
      field.type,
      field.options ?? null,
      field.description,
    );
  }
  return hashes;
}

export async function backfillSchemaVersionHistory(projectId: string) {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();

  const [{ data: project }, { data: log, error: logErr }] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .eq("id", projectId)
      .single(),
    supabase
      .from("schema_change_log")
      .select("id, field_name, before_value, after_value, created_at, change_type")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
  ]);

  if (logErr) throw new Error(logErr.message);
  if (!project) throw new Error("Projeto não encontrado ou sem permissão");

  // 1) Classify entries and compute cumulative version per entry
  let current = { major: 0, minor: 1, patch: 0 };
  type EnrichedEntry = {
    id: string;
    field_name: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    createdAt: number;
    changeType: ChangeType;
    version: { major: number; minor: number; patch: number };
  };
  const enriched: EnrichedEntry[] = [];

  for (const entry of log ?? []) {
    const before = (entry.before_value ?? {}) as Record<string, unknown>;
    const after = (entry.after_value ?? {}) as Record<string, unknown>;

    let type: ChangeType;
    if (entry.change_type === "major") {
      type = "major";
    } else {
      type = fieldDiffIsStructural(before, after) ? "minor" : "patch";
    }

    current = bumpVersion(current, type);
    enriched.push({
      id: entry.id as string,
      field_name: entry.field_name as string,
      before,
      after,
      createdAt: new Date(entry.created_at as string).getTime(),
      changeType: type,
      version: { ...current },
    });
  }

  // 2) Update each log entry with classification + version
  await Promise.all(
    enriched.map((e) =>
      supabase
        .from("schema_change_log")
        .update({
          change_type: e.changeType,
          version_major: e.version.major,
          version_minor: e.version.minor,
          version_patch: e.version.patch,
        })
        .eq("id", e.id),
    ),
  );

  // 3) Set project current version
  await supabase
    .from("projects")
    .update({
      schema_version_major: current.major,
      schema_version_minor: current.minor,
      schema_version_patch: current.patch,
    })
    .eq("id", projectId);

  // 4) Reconstruct snapshots at each version, walking log in reverse.
  // Current project fields = snapshot of the "current" version after all entries applied.
  const currentSnap = new Map<string, FieldSnapshot>();
  for (const f of (project?.pydantic_fields as PydanticField[]) ?? []) {
    currentSnap.set(f.name, cloneFieldSnapshot({ ...f }));
  }

  // Map: versionKey -> snapshot map (fieldName -> snapshot)
  const snapByVersion = new Map<string, Map<string, FieldSnapshot>>();
  snapByVersion.set(versionKey(current), cloneSnapshotMap(currentSnap));

  // Group entries by version so we revert all at once per version-change
  const versionsDesc: Array<{ key: string; version: typeof current }> = [];
  const entriesByVersion = new Map<string, EnrichedEntry[]>();
  for (const e of enriched) {
    const k = versionKey(e.version);
    if (!entriesByVersion.has(k)) {
      entriesByVersion.set(k, []);
      versionsDesc.push({ key: k, version: e.version });
    }
    entriesByVersion.get(k)!.push(e);
  }
  // Sort desc so we revert from latest → earliest
  versionsDesc.sort((a, b) => {
    if (a.version.major !== b.version.major) return b.version.major - a.version.major;
    if (a.version.minor !== b.version.minor) return b.version.minor - a.version.minor;
    return b.version.patch - a.version.patch;
  });

  const workingSnap = cloneSnapshotMap(currentSnap);
  for (let idx = 0; idx < versionsDesc.length; idx++) {
    const { key, version } = versionsDesc[idx];
    // Snapshot at version `version` (before reverting) — if not already stored
    if (!snapByVersion.has(key)) {
      snapByVersion.set(key, cloneSnapshotMap(workingSnap));
    }
    // Revert all entries at this version
    const group = entriesByVersion.get(key)!;
    for (const e of group) {
      // Skip project-level entries (publishMajorVersion)
      if (e.field_name === "(projeto)") continue;
      const isAdd = Object.keys(e.before).length === 0;
      const isRemove = Object.keys(e.after).length === 0;
      if (isAdd) {
        // Pré-E: o campo não existia
        workingSnap.delete(e.field_name);
      } else if (isRemove) {
        // Pré-E: o campo existia como `before`
        const snap = { name: e.field_name, ...(e.before as Partial<PydanticField>) };
        workingSnap.set(e.field_name, snap);
      } else {
        // Campo modificado: reverte atributos listados em `before`
        const existing = workingSnap.get(e.field_name) ?? { name: e.field_name };
        workingSnap.set(e.field_name, {
          ...existing,
          ...(e.before as Partial<PydanticField>),
          name: e.field_name,
        });
      }
    }
    // Após reverter, workingSnap representa a versão anterior
    const prev = versionsDesc[idx + 1];
    if (!prev) {
      // 0.1.0 inicial (pré-primeira entry)
      snapByVersion.set(versionKey({ major: 0, minor: 1, patch: 0 }), cloneSnapshotMap(workingSnap));
    }
  }

  // Compute hashes per version
  const hashesByVersion = new Map<string, Record<string, string>>();
  for (const [k, snap] of snapByVersion) {
    hashesByVersion.set(k, computeHashesFromSnapshot(snap));
  }

  // 5) Assign versions to responses (paginate to avoid implicit 1000-row cap)
  const RESPONSES_PAGE = 500;
  type ResponseRow = {
    id: string;
    created_at: string;
    answer_field_hashes: Record<string, string> | null;
    version_inferred_from: string | null;
  };
  const responses: ResponseRow[] = [];
  for (let from = 0; ; from += RESPONSES_PAGE) {
    const { data: page, error: pageErr } = await supabase
      .from("responses")
      .select("id, created_at, answer_field_hashes, version_inferred_from")
      .eq("project_id", projectId)
      .range(from, from + RESPONSES_PAGE - 1);
    if (pageErr) throw new Error(pageErr.message);
    if (!page || page.length === 0) break;
    responses.push(...(page as unknown as ResponseRow[]));
    if (page.length < RESPONSES_PAGE) break;
  }

  const allVersionKeys = [...hashesByVersion.keys()];
  const versionByKey = new Map<string, { major: number; minor: number; patch: number }>();
  for (const k of allVersionKeys) {
    const [mj, mn, pt] = k.split(".").map((n) => Number.parseInt(n, 10));
    versionByKey.set(k, { major: mj, minor: mn, patch: pt });
  }
  // Timestamp of each version (from entries; initial version = 0)
  const versionTs = new Map<string, number>();
  for (const e of enriched) {
    const k = versionKey(e.version);
    if (!versionTs.has(k)) versionTs.set(k, e.createdAt);
  }
  versionTs.set(versionKey({ major: 0, minor: 1, patch: 0 }), 0);

  // Bucket updates by (version, method)
  const updates = new Map<
    string, // versionKey + "|" + method
    { version: { major: number; minor: number; patch: number }; method: string; ids: string[] }
  >();

  let countLiveSave = 0;

  for (const r of responses) {
    // Preserve live_save entries as-is (precisão total)
    if (r.version_inferred_from === "live_save") {
      countLiveSave++;
      continue;
    }

    const rHashes = (r.answer_field_hashes as Record<string, string> | null) ?? null;
    const ts = new Date(r.created_at as string).getTime();

    let chosenKey: string | null = null;
    let chosenMethod: "hashes" | "created_at" | "fallback_created_at" = "created_at";

    if (rHashes && Object.keys(rHashes).length > 0) {
      // Score each version
      let bestScore = -1;
      let bestKey: string | null = null;
      let bestTieTs = Infinity;
      for (const [k, vHashes] of hashesByVersion) {
        let score = 0;
        for (const [fn, h] of Object.entries(rHashes)) {
          if (vHashes[fn] === h) score++;
        }
        if (score === 0) continue;
        const kTs = versionTs.get(k) ?? 0;
        const tieMetric = Math.abs(kTs - ts);
        if (
          score > bestScore ||
          (score === bestScore && tieMetric < bestTieTs)
        ) {
          bestScore = score;
          bestKey = k;
          bestTieTs = tieMetric;
        }
      }
      if (bestKey) {
        chosenKey = bestKey;
        chosenMethod = "hashes";
      }
    }

    if (!chosenKey) {
      // Fallback timestamp
      const candidates = [...versionTs.entries()]
        .filter(([, t]) => t <= ts)
        .sort((a, b) => b[1] - a[1]);
      chosenKey = candidates.length > 0
        ? candidates[0][0]
        : versionKey({ major: 0, minor: 1, patch: 0 });
      chosenMethod = rHashes && Object.keys(rHashes).length > 0
        ? "fallback_created_at"
        : "created_at";
    }

    const v = versionByKey.get(chosenKey) ?? { major: 0, minor: 1, patch: 0 };
    const bucketKey = `${chosenKey}|${chosenMethod}`;
    if (!updates.has(bucketKey)) {
      updates.set(bucketKey, { version: v, method: chosenMethod, ids: [] });
    }
    updates.get(bucketKey)!.ids.push(r.id as string);
  }

  let countHashes = 0;
  let countCreatedAt = 0;
  let countFallback = 0;

  const updatePromises = [];
  for (const bucket of updates.values()) {
    if (bucket.method === "hashes") countHashes += bucket.ids.length;
    else if (bucket.method === "created_at") countCreatedAt += bucket.ids.length;
    else if (bucket.method === "fallback_created_at") countFallback += bucket.ids.length;

    for (let i = 0; i < bucket.ids.length; i += 100) {
      const chunk = bucket.ids.slice(i, i + 100);
      updatePromises.push(
        supabase
          .from("responses")
          .update({
            schema_version_major: bucket.version.major,
            schema_version_minor: bucket.version.minor,
            schema_version_patch: bucket.version.patch,
            version_inferred_from: bucket.method,
          })
          .in("id", chunk),
      );
    }
  }
  await Promise.all(updatePromises);

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/config/schema`);
  revalidatePath(`/projects/${projectId}/reviews`);

  return {
    finalVersion: current,
    logEntriesUpdated: enriched.length,
    responsesProcessed: responses.length,
    byMethod: {
      hashes: countHashes,
      created_at: countCreatedAt,
      fallback_created_at: countFallback,
      live_save: countLiveSave,
    },
  };
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
