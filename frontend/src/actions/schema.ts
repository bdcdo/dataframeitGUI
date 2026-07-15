"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import { fetchFastAPIServer } from "@/lib/api-server";
import type {
  PydanticField,
  SchemaBaselineIdentity,
  SchemaSaveResult,
  SchemaSnapshot,
} from "@/lib/types";
import {
  bumpVersion,
  planSchemaPersistence,
  schemaBaselineIdentity,
} from "@/lib/schema-utils";
import { updateOrThrow } from "@/lib/supabase/rls-guard";
import { errorMessage } from "@/lib/utils";
import {
  classifyLogEntries,
  reconstructSnapshotsByVersion,
  matchResponsesToVersions,
  computeHashesFromSnapshot,
  type BackfillStats,
  type EnrichedEntry,
  type LogEntryRow,
  type ResponseRow,
  type UpdateBucket,
} from "@/lib/schema-backfill";
import crypto from "crypto";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;

interface SchemaProjectRow {
  pydantic_fields: PydanticField[] | null;
  pydantic_code: string | null;
  pydantic_hash: string | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
}

const SCHEMA_PROJECT_SELECT =
  "pydantic_fields, pydantic_code, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch";

function projectVersion(project: Partial<SchemaProjectRow>): {
  major: number;
  minor: number;
  patch: number;
} {
  return {
    major: project.schema_version_major ?? 0,
    minor: project.schema_version_minor ?? 1,
    patch: project.schema_version_patch ?? 0,
  };
}

function versionString(version: { major: number; minor: number; patch: number }): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function projectSnapshot(project: Partial<SchemaProjectRow>): SchemaSnapshot {
  const fields = project.pydantic_fields ?? [];
  return {
    fields,
    ...schemaBaselineIdentity(fields, versionString(projectVersion(project))),
  };
}

function sameCasIdentity(
  left: Partial<SchemaProjectRow>,
  right: Partial<SchemaProjectRow>,
): boolean {
  const leftVersion = projectVersion(left);
  const rightVersion = projectVersion(right);
  return (
    leftVersion.major === rightVersion.major &&
    leftVersion.minor === rightVersion.minor &&
    leftVersion.patch === rightVersion.patch &&
    (left.pydantic_hash ?? null) === (right.pydantic_hash ?? null)
  );
}

function conflictResult(project: Partial<SchemaProjectRow>): SchemaSaveResult {
  return {
    conflict: projectSnapshot(project),
    error:
      "O schema foi alterado em outra aba ou sessão. O seu rascunho foi preservado para revisão.",
  };
}

interface SchemaSaveContext {
  project: SchemaProjectRow;
  oldFields: PydanticField[];
  current: { major: number; minor: number; patch: number };
}

type SchemaContextLoad =
  | { context: SchemaSaveContext }
  | { result: SchemaSaveResult };

type SchemaPersistencePlan = ReturnType<typeof planSchemaPersistence>;

async function loadSchemaSaveContext(
  supabase: SupabaseServerClient,
  projectId: string,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaContextLoad> {
  // `pydantic_code` precisa participar desta leitura: schemas legados podem
  // ter código persistido sem `pydantic_fields`, e esse estado não pode ser
  // sobrescrito por um editor visual vazio.
  const { data } = await supabase
    .from("projects")
    .select(SCHEMA_PROJECT_SELECT)
    .eq("id", projectId)
    .single();
  if (!data) {
    return { result: { error: "Projeto não encontrado ou sem permissão" } };
  }

  const project = data as SchemaProjectRow;
  const remoteBaseline = projectSnapshot(project);
  if (
    expectedBaseline.version !== remoteBaseline.version ||
    expectedBaseline.fingerprint !== remoteBaseline.fingerprint
  ) {
    return { result: conflictResult(project) };
  }

  return {
    context: {
      project,
      oldFields: project.pydantic_fields || [],
      current: projectVersion(project),
    },
  };
}

function schemaWouldBeWiped(
  fields: PydanticField[],
  context: SchemaSaveContext,
): boolean {
  if (fields.length > 0) return false;
  return context.oldFields.length > 0 || Boolean(context.project.pydantic_code);
}

async function resolveSchemaWrite(
  supabase: SupabaseServerClient,
  projectId: string,
  original: SchemaProjectRow,
  write: { error?: string; casMiss?: boolean },
): Promise<SchemaSaveResult | null> {
  if (write.error) return { error: write.error };
  if (!write.casMiss) return null;

  const { data } = await supabase
    .from("projects")
    .select(SCHEMA_PROJECT_SELECT)
    .eq("id", projectId)
    .single();
  if (!data || sameCasIdentity(original, data as SchemaProjectRow)) {
    return {
      error: "Não foi possível salvar o schema: sem permissão para alterar este projeto.",
    };
  }
  return conflictResult(data as SchemaProjectRow);
}

function savedSchemaSnapshot(plan: SchemaPersistencePlan): SchemaSnapshot {
  const version = versionString(plan.bumped);
  return {
    fields: plan.fieldsWithHash,
    version,
    fingerprint: schemaBaselineIdentity(plan.fieldsWithHash, version).fingerprint,
  };
}

async function persistSchemaAuditLog({
  supabase,
  projectId,
  userId,
  plan,
  saved,
}: {
  supabase: SupabaseServerClient;
  projectId: string;
  userId: string | undefined;
  plan: SchemaPersistencePlan;
  saved: SchemaSnapshot;
}): Promise<SchemaSaveResult | null> {
  if (!userId || plan.logEntries.length === 0) return null;
  const { error } = await supabase.from("schema_change_log").insert(
    plan.logEntries.map((entry) => ({
      project_id: projectId,
      changed_by: userId,
      change_type: plan.changeType ?? "patch",
      version_major: plan.bumped.major,
      version_minor: plan.bumped.minor,
      version_patch: plan.bumped.patch,
      ...entry,
    })),
  );
  if (!error) return null;
  return {
    saved,
    error: `Schema salvo, mas falha ao registrar o histórico: ${error.message}`,
  };
}

interface RecoverResponse {
  valid: boolean;
  fields: PydanticField[];
  model_name: string | null;
  errors: string[];
}

// Repopula os campos a partir do `pydantic_code` ARMAZENADO do projeto (lido no
// backend via service key, não enviado pelo cliente — logo sem vetor do #163).
// Usado quando um projeto legado tem código mas o editor visual abre vazio.
// fetchFastAPIServer (não fetchFastAPI): o endpoint /recover-fields passou a
// exigir auth de coordenador (#195), então a server action injeta o token JWT.
export async function recoverFieldsFromStoredCode(
  projectId: string,
): Promise<{ fields?: PydanticField[]; error?: string }> {
  try {
    const result = await fetchFastAPIServer<RecoverResponse>(
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
    return { error: errorMessage(e) || "Erro ao recuperar campos do código" };
  }
}

// As actions deste arquivo retornam { error } em vez de lançar: o Next mascara
// a message de erros lançados em Server Actions em produção (o client recebe
// mensagem genérica + digest), então a copy pt-BR só chega ao toast pelo
// retorno. Os helpers de rls-guard continuam lançando — o catch fica na
// fronteira da action. A extração da message usa `errorMessage` de @/lib/utils
// (fonte única, compartilhada com o hook de upload); `|| fallback` cobre o caso
// de `e` não ser Error/string.

// Não exportada: usada apenas internamente por saveSchemaFromGUI. A edição
// manual do código foi descontinuada, então não há Server Action que receba
// código Pydantic cru do cliente.
async function saveSchema(
  supabase: SupabaseServerClient,
  projectId: string,
  code: string,
  fields: PydanticField[],
  expectedRow: {
    version: { major: number; minor: number; patch: number };
    pydanticHash: string | null;
  },
  versionBump?: { major: number; minor: number; patch: number },
): Promise<{ error?: string; casMiss?: boolean }> {
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

  let query = supabase
    .from("projects")
    .update(updatePayload)
    .eq("id", projectId)
    .eq("schema_version_major", expectedRow.version.major)
    .eq("schema_version_minor", expectedRow.version.minor)
    .eq("schema_version_patch", expectedRow.version.patch);
  query = expectedRow.pydanticHash === null
    ? query.is("pydantic_hash", null)
    : query.eq("pydantic_hash", expectedRow.pydanticHash);
  const { data, error } = await query.select("id");
  if (error) return { error: error.message };
  if (!data || data.length === 0) return { casMiss: true };

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
    return { error: errorMessage(e) || "Erro ao salvar o prompt" };
  }
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/llm/configure`);
  return {};
}

// ---------- Save from GUI ----------
//
// Orquestrador fino: lê o estado antigo, delega o cálculo a
// planSchemaPersistence (lib/schema-utils.ts, pura) e faz os writes. A mesma
// função é usada por apply-decisions.ts (fora do Next runtime) para eliminar
// drift — ver #63/PR #352.

export async function saveSchemaFromGUI(
  projectId: string,
  fields: PydanticField[],
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaSaveResult> {
  const [supabase, user] = await Promise.all([
    createSupabaseServer(),
    getAuthUser(),
  ]);

  const loaded = await loadSchemaSaveContext(
    supabase,
    projectId,
    expectedBaseline,
  );
  if ("result" in loaded) return loaded.result;
  const context = loaded.context;

  // Guarda anti-wipe: nunca sobrescrever um schema existente com 0 campos. Sem
  // isto, abrir um projeto cujo editor visual ficou vazio (ex.: legado com
  // pydantic_code mas pydantic_fields não carregado) e clicar "Salvar"
  // regeneraria `class Analysis(BaseModel): pass`, apagando schema + campos em
  // silêncio. Um schema realmente vazio só é salvável quando já estava vazio.
  //
  if (schemaWouldBeWiped(fields, context)) {
    return {
      error:
        "Salvar com 0 campos apagaria o schema atual. Adicione ao menos um campo, ou use 'Recuperar do código' se o editor abriu vazio.",
    };
  }

  // Classificação, versão, log de auditoria, código Pydantic e hash: cálculo
  // puro compartilhado com apply-decisions.ts via planSchemaPersistence
  // (schema-utils.ts) — ver #63/PR #352 (evita drift entre os dois callers).
  const plan = planSchemaPersistence(
    context.oldFields,
    fields,
    context.current,
  );

  const write = await saveSchema(
    supabase,
    projectId,
    plan.code,
    plan.fieldsWithHash,
    {
      version: context.current,
      pydanticHash: context.project.pydantic_hash,
    },
    plan.changeType ? plan.bumped : undefined,
  );
  const writeResult = await resolveSchemaWrite(
    supabase,
    projectId,
    context.project,
    write,
  );
  if (writeResult) return writeResult;

  // O cliente precisa do baseline efetivamente persistido (inclusive a versão
  // calculada contra o estado remoto) para distinguir novas edições locais do
  // snapshot que acabou de ser salvo.
  const savedState = savedSchemaSnapshot(plan);

  // Insert audit log entries com change_type + versão alvo. Só roda depois
  // que saveSchema confirmou ≥1 linha atualizada (erro em 0-rows) — antes o
  // log era gravado mesmo com o UPDATE de projects filtrado pela RLS, gerando
  // histórico fantasma (#178).
  const auditResult = await persistSchemaAuditLog({
    supabase,
    projectId,
    userId: user?.id,
    plan,
    saved: savedState,
  });
  if (auditResult) return auditResult;
  return { saved: savedState };
}

// ---------- Backfill retroativo usando schema_change_log ----------
// Reconstrói a versão do projeto a partir do histórico já registrado.
// - Classifica entries não classificadas (minor/patch), respeita majors já setados.
// - Reconstrói snapshots do schema em cada versão (reverter diffs do atual).
// - Atribui versão a cada resposta usando answer_field_hashes quando disponível;
//   cai em created_at quando não (responses pré-hash).
// - Rastreia o método em responses.version_inferred_from.
// Idempotente.
//
// As etapas puras (classificação, snapshots, matching) vivem em
// @/lib/schema-backfill — "use server" só pode exportar funções async, então
// o que é puro e testável fica fora deste arquivo.

// Fronteira da action: runBackfill lança nos vários pontos de falha (leituras,
// updates filtrados, permissões) e aqui o throw vira { error } para a copy
// chegar ao client em produção.
export async function backfillSchemaVersionHistory(
  projectId: string,
): Promise<{ stats?: BackfillStats; error?: string }> {
  try {
    return { stats: await runBackfill(projectId) };
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao reconstruir o histórico de versões" };
  }
}

async function persistLogClassification(
  supabase: SupabaseServerClient,
  enriched: EnrichedEntry[],
): Promise<void> {
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
}

async function fetchAllResponses(
  supabase: SupabaseServerClient,
  projectId: string,
): Promise<ResponseRow[]> {
  const RESPONSES_PAGE = 500;
  const responses: ResponseRow[] = [];
  for (let from = 0; ; from += RESPONSES_PAGE) {
    // Paginação sequencial: a próxima página depende de a anterior ter retornado
    // uma página cheia; não há como paralelizar sem saber o total de linhas.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
  return responses;
}

async function persistResponseVersionUpdates(
  supabase: SupabaseServerClient,
  updates: Map<string, UpdateBucket>,
): Promise<void> {
  const updatePromises = [];
  for (const bucket of updates.values()) {
    const { ids, method, version } = bucket;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      updatePromises.push(
        supabase
          .from("responses")
          .update({
            schema_version_major: version.major,
            schema_version_minor: version.minor,
            schema_version_patch: version.patch,
            version_inferred_from: method,
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

  const { enriched, finalVersion } = classifyLogEntries((log ?? []) as LogEntryRow[]);

  await persistLogClassification(supabase, enriched);

  await updateOrThrow(
    supabase,
    "projects",
    {
      schema_version_major: finalVersion.major,
      schema_version_minor: finalVersion.minor,
      schema_version_patch: finalVersion.patch,
    },
    { id: projectId },
    { message: "Backfill: sem permissão para atualizar a versão do projeto." },
  );

  const snapByVersion = reconstructSnapshotsByVersion(
    ((project?.pydantic_fields as PydanticField[]) ?? []),
    enriched,
    finalVersion,
  );

  const hashesByVersion = new Map<string, Record<string, string>>();
  for (const [k, snap] of snapByVersion) {
    hashesByVersion.set(k, computeHashesFromSnapshot(snap));
  }

  const responses = await fetchAllResponses(supabase, projectId);

  const { updates, byMethod } = matchResponsesToVersions(responses, hashesByVersion, enriched);

  await persistResponseVersionUpdates(supabase, updates);

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/config/schema`);
  revalidatePath(`/projects/${projectId}/reviews`);

  return {
    finalVersion,
    logEntriesUpdated: enriched.length,
    responsesProcessed: responses.length,
    byMethod,
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
    return { error: errorMessage(e) || "Erro ao publicar a MAJOR" };
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
    .select(
      "pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch",
    )
    .eq("id", projectId)
    .single();

  let fields = (project?.pydantic_fields as PydanticField[]) || [];
  const expectedBaseline = schemaBaselineIdentity(
    fields,
    versionString(projectVersion(project ?? {})),
  );

  if (enabled) {
    if (!fields.some((f) => f.name === fieldDef.name)) {
      fields = [...fields, fieldDef];
    }
  } else {
    fields = fields.filter((f) => f.name !== fieldDef.name);
  }

  return saveSchemaFromGUI(projectId, fields, expectedBaseline);
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
    return { error: errorMessage(e) || "Erro ao salvar a configuração do LLM" };
  }
  revalidatePath(`/projects/${projectId}/llm/configure`);
  revalidatePath(`/projects/${projectId}/config`);
  return {};
}
