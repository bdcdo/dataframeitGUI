"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import type { PydanticField } from "@/lib/types";
import {
  generatePydanticCode,
  computeFieldHash,
  classifyChange,
  bumpVersion,
  diffFields,
  fieldDiffIsStructural,
  type ChangeType,
} from "@/lib/schema-utils";
import { updateOrThrow } from "@/lib/supabase/rls-guard";
import { fetchFastAPI } from "@/lib/api";
import crypto from "crypto";

interface RecoverResponse {
  valid: boolean;
  fields: PydanticField[];
  model_name: string | null;
  errors: string[];
}

// Repopula os campos a partir do `pydantic_code` ARMAZENADO do projeto (lido no
// backend via service key, não enviado pelo cliente — logo sem vetor do #163).
// Usado quando um projeto legado tem código mas o editor visual abre vazio.
export async function recoverFieldsFromStoredCode(
  projectId: string,
): Promise<{ fields?: PydanticField[]; error?: string }> {
  try {
    const result = await fetchFastAPI<RecoverResponse>(
      "/api/pydantic/recover-fields",
      { method: "POST", body: JSON.stringify({ project_id: projectId }) },
    );
    if (!result.valid) {
      return {
        error:
          result.errors[0] ||
          "Não foi possível reconstruir os campos a partir do código armazenado.",
      };
    }
    return { fields: result.fields };
  } catch (e) {
    return { error: errorMessage(e, "Erro ao recuperar campos do código") };
  }
}

// As actions deste arquivo retornam { error } em vez de lançar: o Next mascara
// a message de erros lançados em Server Actions em produção (o client recebe
// mensagem genérica + digest), então a copy pt-BR só chega ao toast pelo
// retorno. Os helpers de rls-guard continuam lançando — o catch fica na
// fronteira da action.
function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

// Não exportada: usada apenas internamente por saveSchemaFromGUI. A edição
// manual do código foi descontinuada, então não há Server Action que receba
// código Pydantic cru do cliente.
async function saveSchema(
  projectId: string,
  code: string,
  fields: PydanticField[],
  versionBump?: { major: number; minor: number; patch: number },
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServer();
  const hash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 16);

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

  try {
    await updateOrThrow(supabase, "projects", updatePayload, { id: projectId }, {
      message:
        "Não foi possível salvar o schema: sem permissão para alterar este projeto.",
    });
  } catch (e) {
    return { error: errorMessage(e, "Erro ao salvar o schema") };
  }

  // is_latest não é flipado para false aqui — staleness é detectada no
  // display via answer_field_hashes (lib/reviews/queries.ts:isFieldStale).
  // Caso contrário, ajustar schema durante uma revisão de erros LLM apaga as
  // respostas antigas e perde o contexto da investigação. Ver #85.

  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/reviews`);
  revalidatePath(`/projects/${projectId}/llm/configure`);
  revalidateTag(`project-${projectId}-progress`, { expire: 60 });
  return {};
}

export async function savePrompt(
  projectId: string,
  promptTemplate: string,
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServer();
  try {
    await updateOrThrow(
      supabase,
      "projects",
      { prompt_template: promptTemplate },
      { id: projectId },
      { message: "Não foi possível salvar o prompt: sem permissão para alterar este projeto." },
    );
  } catch (e) {
    return { error: errorMessage(e, "Erro ao salvar o prompt") };
  }
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/llm/configure`);
  return {};
}

// ---------- Save from GUI ----------
//
// Orquestrador fino: lê o estado antigo, delega a classificação/diff às
// primitivas puras de lib/schema-utils.ts e faz os writes. As primitivas
// (classifyChange, bumpVersion, diffFields, computeFieldHash) são compartilhadas
// com scripts fora do Next runtime para eliminar drift — ver #63.

export async function saveSchemaFromGUI(
  projectId: string,
  fields: PydanticField[]
): Promise<{ error?: string }> {
  const [supabase, user] = await Promise.all([
    createSupabaseServer(),
    getAuthUser(),
  ]);

  // Fetch old fields + current version. `pydantic_code` entra no select por
  // causa da guarda anti-wipe abaixo: o caso legado a proteger tem justamente
  // `pydantic_fields` vazio mas `pydantic_code` presente, então a guarda
  // precisa enxergar o código para não deixar passar o wipe.
  const { data: project } = await supabase
    .from("projects")
    .select(
      "pydantic_fields, pydantic_code, schema_version_major, schema_version_minor, schema_version_patch",
    )
    .eq("id", projectId)
    .single();

  const oldFields = (project?.pydantic_fields as PydanticField[]) || [];

  // Guarda anti-wipe: nunca sobrescrever um schema existente com 0 campos. Sem
  // isto, abrir um projeto cujo editor visual ficou vazio (ex.: legado com
  // pydantic_code mas pydantic_fields não carregado) e clicar "Salvar"
  // regeneraria `class Analysis(BaseModel): pass`, apagando schema + campos em
  // silêncio. Um schema realmente vazio só é salvável quando já estava vazio.
  //
  // A condição testa `pydantic_code` ALÉM de `oldFields` justamente porque o
  // caso legado documentado acima tem `pydantic_fields` vazio (oldFields === [])
  // mas `pydantic_code` populado: checar só `oldFields.length > 0` deixaria o
  // wipe passar exatamente no cenário que a guarda existe para impedir.
  const hasExistingSchema = oldFields.length > 0 || !!project?.pydantic_code;
  if (fields.length === 0 && hasExistingSchema) {
    return {
      error:
        "Salvar com 0 campos apagaria o schema atual. Adicione ao menos um campo, ou use 'Recuperar do código' se o editor abriu vazio.",
    };
  }

  const current = {
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  };

  const changeType = classifyChange(oldFields, fields);
  const bumped = changeType ? bumpVersion(current, changeType) : current;

  // Detect per-field changes and build log entries
  const logEntries = diffFields(oldFields, fields);

  // Save schema com versão bumpada (ou mantida se não houve mudança)
  const code = generatePydanticCode(fields);
  const fieldsWithHash = fields.map((f) => ({
    ...f,
    hash: computeFieldHash(f.name, f.type, f.options, f.description),
  }));
  const saved = await saveSchema(projectId, code, fieldsWithHash, changeType ? bumped : undefined);
  if (saved.error) return saved;

  // Insert audit log entries com change_type + versão alvo. Só roda depois
  // que saveSchema confirmou ≥1 linha atualizada (erro em 0-rows) — antes o
  // log era gravado mesmo com o UPDATE de projects filtrado pela RLS, gerando
  // histórico fantasma (#178).
  if (logEntries.length > 0 && user) {
    const { error: logErr } = await supabase.from("schema_change_log").insert(
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
    if (logErr) {
      return {
        error: `Schema salvo, mas falha ao registrar o histórico: ${logErr.message}`,
      };
    }
  }
  return {};
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

type BackfillStats = {
  finalVersion: { major: number; minor: number; patch: number };
  logEntriesUpdated: number;
  responsesProcessed: number;
  byMethod: {
    hashes: number;
    created_at: number;
    fallback_created_at: number;
    live_save: number;
  };
};

// Fronteira da action: runBackfill lança nos vários pontos de falha (leituras,
// updates filtrados, permissões) e aqui o throw vira { error } para a copy
// chegar ao client em produção.
export async function backfillSchemaVersionHistory(
  projectId: string,
): Promise<{ stats?: BackfillStats; error?: string }> {
  try {
    return { stats: await runBackfill(projectId) };
  } catch (e) {
    return { error: errorMessage(e, "Erro ao reconstruir o histórico de versões") };
  }
}

async function runBackfill(projectId: string): Promise<BackfillStats> {
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
  const logUpdateResults = await Promise.all(
    enriched.map((e) =>
      supabase
        .from("schema_change_log")
        .update({
          change_type: e.changeType,
          version_major: e.version.major,
          version_minor: e.version.minor,
          version_patch: e.version.patch,
        })
        .eq("id", e.id)
        .select("id"),
    ),
  );
  const logUpdateFailures = logUpdateResults.filter(
    (r) => r.error || !r.data || r.data.length === 0,
  );
  if (logUpdateFailures.length > 0) {
    const firstErr = logUpdateFailures.find((r) => r.error)?.error;
    throw new Error(
      `Backfill: ${logUpdateFailures.length} de ${enriched.length} entradas do histórico não puderam ser atualizadas` +
        (firstErr ? ` (${firstErr.message})` : " (sem permissão de UPDATE em schema_change_log)"),
    );
  }

  // 3) Set project current version
  await updateOrThrow(
    supabase,
    "projects",
    {
      schema_version_major: current.major,
      schema_version_minor: current.minor,
      schema_version_patch: current.patch,
    },
    { id: projectId },
    { message: "Backfill: sem permissão para atualizar a versão do projeto." },
  );

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
    const { ids, method } = bucket;
    const idsLength = ids.length;
    if (method === "hashes") countHashes += idsLength;
    else if (method === "created_at") countCreatedAt += idsLength;
    else if (method === "fallback_created_at") countFallback += idsLength;

    for (let i = 0; i < idsLength; i += 100) {
      const chunk = ids.slice(i, i + 100);
      updatePromises.push(
        supabase
          .from("responses")
          .update({
            schema_version_major: bucket.version.major,
            schema_version_minor: bucket.version.minor,
            schema_version_patch: bucket.version.patch,
            version_inferred_from: bucket.method,
          })
          .in("id", chunk)
          .select("id")
          .then((r) => ({ result: r, expected: chunk.length })),
      );
    }
  }
  const responseUpdateResults = await Promise.all(updatePromises);
  for (const { result, expected } of responseUpdateResults) {
    if (result.error) {
      throw new Error(`Backfill: falha ao versionar respostas (${result.error.message})`);
    }
    const affected = result.data?.length ?? 0;
    if (affected < expected) {
      throw new Error(
        `Backfill: ${expected - affected} resposta(s) não puderam ser versionadas (sem permissão de UPDATE em responses).`,
      );
    }
  }

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

// Em sucesso retorna { bumped }; em falha parcial (versão publicada mas log
// não gravado) retorna { bumped, error } para a UI poder refletir o estado.
export async function publishMajorVersion(
  projectId: string,
): Promise<{ bumped?: { major: number; minor: number; patch: number }; error?: string }> {
  const [supabase, user] = await Promise.all([
    createSupabaseServer(),
    getAuthUser(),
  ]);
  if (!user) return { error: "Não autenticado" };

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

  try {
    await updateOrThrow(
      supabase,
      "projects",
      {
        schema_version_major: bumped.major,
        schema_version_minor: bumped.minor,
        schema_version_patch: bumped.patch,
      },
      { id: projectId },
      { message: "Não foi possível publicar a MAJOR: sem permissão para alterar este projeto." },
    );
  } catch (e) {
    return { error: errorMessage(e, "Erro ao publicar a MAJOR") };
  }

  const { error: logErr } = await supabase.from("schema_change_log").insert({
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
  revalidatePath(`/projects/${projectId}/llm/configure`);

  if (logErr) {
    return {
      bumped,
      error: `MAJOR publicada, mas falha ao registrar o histórico: ${logErr.message}`,
    };
  }
  return { bumped };
}

export async function toggleLlmField(
  projectId: string,
  fieldDef: PydanticField,
  enabled: boolean
): Promise<{ error?: string }> {
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

  return saveSchemaFromGUI(projectId, fields);
}

export async function saveLlmConfig(
  projectId: string,
  config: {
    llm_provider: string;
    llm_model: string;
    llm_kwargs: Record<string, unknown>;
  }
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServer();
  try {
    await updateOrThrow(supabase, "projects", config, { id: projectId }, {
      message:
        "Não foi possível salvar a configuração do LLM: sem permissão para alterar este projeto.",
    });
  } catch (e) {
    return { error: errorMessage(e, "Erro ao salvar a configuração do LLM") };
  }
  revalidatePath(`/projects/${projectId}/llm/configure`);
  revalidatePath(`/projects/${projectId}/config`);
  return {};
}
