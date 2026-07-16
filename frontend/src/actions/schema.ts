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
  type SchemaPersistencePlan,
} from "@/lib/schema-utils";
import { updateOrThrow } from "@/lib/supabase/rls-guard";
import { errorMessage } from "@/lib/utils";
import {
  parsePydanticFields,
  parseSaveablePydanticFields,
} from "@/lib/pydantic-field";
import {
  classifyLogEntries,
  reconstructSnapshotsByVersion,
  matchResponsesToVersions,
  computeHashesFromSnapshot,
  type BackfillStats,
  type LogEntryRow,
  type ResponseRow,
} from "@/lib/schema-backfill";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;

interface SchemaProjectRow {
  pydantic_fields: PydanticField[];
  pydantic_code: string | null;
  pydantic_hash: string | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
  schema_revision: number | null;
}

const SCHEMA_PROJECT_SELECT =
  "pydantic_fields, pydantic_code, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch, schema_revision";

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

function projectSnapshot(project: SchemaProjectRow): SchemaSnapshot {
  return {
    fields: project.pydantic_fields,
    version: versionString(projectVersion(project)),
    revision: project.schema_revision ?? 0,
  };
}

function conflictResult(project: SchemaProjectRow): SchemaSaveResult {
  return {
    status: "conflict",
    current: projectSnapshot(project),
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

type AuthenticatedSchemaContextLoad =
  | {
      supabase: SupabaseServerClient;
      userId: string;
      context: SchemaSaveContext;
    }
  | { result: SchemaSaveResult };

async function loadSchemaSaveContext(
  supabase: SupabaseServerClient,
  projectId: string,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaContextLoad> {
  // O snapshot completo também atende a publicação MAJOR, que reapresenta o
  // mesmo código e os mesmos campos à RPC ao alterar somente a versão.
  const { data } = await supabase
    .from("projects")
    .select(SCHEMA_PROJECT_SELECT)
    .eq("id", projectId)
    .single();
  if (!data) {
    return {
      result: {
        status: "error",
        message: "Projeto não encontrado ou sem permissão",
      },
    };
  }

  const project = data as SchemaProjectRow;
  const persistedFields = parsePydanticFields(project.pydantic_fields);
  if (!persistedFields) {
    return {
      result: {
        status: "error",
        message: "O schema persistido é inválido e precisa ser corrigido antes da edição.",
      },
    };
  }
  project.pydantic_fields = persistedFields;
  const remoteBaseline = projectSnapshot(project);
  if (
    expectedBaseline.revision !== remoteBaseline.revision ||
    project.schema_revision == null
  ) {
    return { result: conflictResult(project) };
  }

  return {
    context: {
      project,
      oldFields: persistedFields,
      current: projectVersion(project),
    },
  };
}

async function loadAuthenticatedSchemaContext(
  projectId: string,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<AuthenticatedSchemaContextLoad> {
  const [supabase, user] = await Promise.all([
    createSupabaseServer(),
    getAuthUser(),
  ]);
  if (!user) return { result: { status: "error", message: "Não autenticado" } };

  const loaded = await loadSchemaSaveContext(supabase, projectId, expectedBaseline);
  if ("result" in loaded) return loaded;
  return { supabase, userId: user.id, context: loaded.context };
}

interface SchemaCommitRow {
  status: string;
  schema_revision: number;
  pydantic_fields: PydanticField[];
  schema_version_major: number;
  schema_version_minor: number;
  schema_version_patch: number;
}

function commitSnapshot(row: SchemaCommitRow): SchemaSnapshot | null {
  const fields = parsePydanticFields(row.pydantic_fields);
  if (!fields) return null;
  return {
    fields,
    revision: row.schema_revision,
    version: versionString({
      major: row.schema_version_major,
      minor: row.schema_version_minor,
      patch: row.schema_version_patch,
    }),
  };
}

function mapCommitResult(
  data: SchemaCommitRow | null,
  error: { message: string } | null,
): SchemaSaveResult {
  if (error) return { status: "error", message: error.message };
  if (!data) {
    return { status: "error", message: "A operação não retornou o estado do schema." };
  }
  if (data.status === "saved") {
    const snapshot = commitSnapshot(data);
    return snapshot
      ? { status: "saved", snapshot }
      : { status: "error", message: "A operação retornou um schema inválido." };
  }
  if (data.status === "conflict") {
    const current = commitSnapshot(data);
    return current
      ? { status: "conflict", current }
      : { status: "error", message: "O schema remoto em conflito é inválido." };
  }
  if (data.status === "forbidden") {
    return {
      status: "error",
      message: "Sem permissão para alterar o schema deste projeto.",
    };
  }
  if (data.status === "not_found") {
    return { status: "error", message: "Projeto não encontrado." };
  }
  return {
    status: "error",
    message: `Resultado desconhecido ao salvar o schema: ${data.status}`,
  };
}

function revalidateSchemaConsumers(projectId: string): void {
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/reviews`);
  revalidatePath(`/projects/${projectId}/llm/configure`);
  revalidateTag(`project-${projectId}-progress`, { expire: 60 });
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

// As actions tratam erros na fronteira: o Next mascara mensagens lançadas em
// Server Actions em produção, então a copy pt-BR precisa voltar no resultado.

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

interface PreparedSchemaCommit {
  plan: SchemaPersistencePlan;
  targetVersion: { major: number; minor: number; patch: number };
}

function prepareSchemaCommit(
  fields: PydanticField[],
  context: SchemaSaveContext,
  suggestionId?: string,
): PreparedSchemaCommit | { result: SchemaSaveResult } {
  const parsedFields = parseSaveablePydanticFields(fields);
  if (!parsedFields) {
    return { result: {
      status: "error",
      message: "O schema enviado é inválido. Revise os campos e tente novamente.",
    } };
  }
  const plan = planSchemaPersistence(
    context.oldFields,
    parsedFields,
    context.current,
  );
  if (!plan.changeType && plan.logEntries.length === 0) {
    if (suggestionId) {
      return { result: {
        status: "error",
        message: "A sugestão não produz nenhuma alteração no schema atual.",
      } };
    }
    return {
      result: { status: "saved", snapshot: projectSnapshot(context.project) },
    };
  }
  return {
    plan,
    targetVersion: plan.changeType ? plan.bumped : context.current,
  };
}

function schemaCommitRpc(suggestionId?: string) {
  return suggestionId ? "approve_schema_suggestion" : "commit_project_schema";
}

function schemaCommitArgs(
  projectId: string,
  expectedRevision: number,
  userId: string,
  prepared: PreparedSchemaCommit,
  suggestionId?: string,
) {
  const { plan, targetVersion } = prepared;
  return {
    ...(suggestionId && { p_suggestion_id: suggestionId }),
    p_project_id: projectId,
    p_expected_revision: expectedRevision,
    p_pydantic_fields: plan.fieldsWithHash,
    p_pydantic_code: plan.code,
    p_version_major: targetVersion.major,
    p_version_minor: targetVersion.minor,
    p_version_patch: targetVersion.patch,
    p_change_type: plan.changeType ?? "patch",
    p_log_entries: plan.logEntries,
    p_changed_by: userId,
  };
}

async function persistSchema(
  projectId: string,
  fields: PydanticField[],
  expectedBaseline: SchemaBaselineIdentity,
  loaded: Exclude<AuthenticatedSchemaContextLoad, { result: SchemaSaveResult }>,
  suggestionId?: string,
): Promise<SchemaSaveResult> {
  const { supabase, userId, context } = loaded;
  const prepared = prepareSchemaCommit(fields, context, suggestionId);
  if ("result" in prepared) return prepared.result;

  const { data, error } = await supabase
    .rpc(
      schemaCommitRpc(suggestionId),
      schemaCommitArgs(
        projectId,
        expectedBaseline.revision,
        userId,
        prepared,
        suggestionId,
      ),
    )
    .single();
  const result = mapCommitResult(data as SchemaCommitRow | null, error);
  if (result.status === "saved") revalidateSchemaConsumers(projectId);
  return result;
}

export async function saveSchemaFromGUI(
  projectId: string,
  fields: PydanticField[],
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaSaveResult> {
  const loaded = await loadAuthenticatedSchemaContext(projectId, expectedBaseline);
  if ("result" in loaded) return loaded.result;
  return persistSchema(projectId, fields, expectedBaseline, loaded);
}

export async function saveSchemaAndApproveSuggestion(
  projectId: string,
  suggestionId: string,
  fields: PydanticField[],
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaSaveResult> {
  const loaded = await loadAuthenticatedSchemaContext(projectId, expectedBaseline);
  if ("result" in loaded) return loaded.result;
  return persistSchema(
    projectId,
    fields,
    expectedBaseline,
    loaded,
    suggestionId,
  );
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

export type BackfillSchemaResult =
  | { status: "saved"; stats: BackfillStats; snapshot: SchemaSnapshot }
  | { status: "conflict"; current: SchemaSnapshot }
  | { status: "error"; message: string };

export async function backfillSchemaVersionHistory(
  projectId: string,
): Promise<BackfillSchemaResult> {
  try {
    return await runBackfill(projectId);
  } catch (e) {
    return {
      status: "error",
      message: errorMessage(e) || "Erro ao reconstruir o histórico de versões",
    };
  }
}

const BACKFILL_PAGE_SIZE = 500;

interface BackfillPage<T> {
  data: T[] | null;
  error: { message: string } | null;
}

async function fetchAllPages<T>(
  loadPage: (from: number, to: number) => Promise<BackfillPage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += BACKFILL_PAGE_SIZE) {
    // A próxima página depende de a anterior estar cheia; o total não é
    // conhecido sem uma consulta adicional que também poderia ficar stale.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const { data, error } = await loadPage(from, from + BACKFILL_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return rows;
    rows.push(...data);
    if (data.length < BACKFILL_PAGE_SIZE) return rows;
  }
}

function fetchAllResponses(
  supabase: SupabaseServerClient,
  projectId: string,
): Promise<ResponseRow[]> {
  return fetchAllPages(async (from, to) => {
    const { data, error } = await supabase
      .from("responses")
      .select("id, created_at, answer_field_hashes, version_inferred_from")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    return { data: data as unknown as ResponseRow[] | null, error };
  });
}

function fetchAllLogEntries(
  supabase: SupabaseServerClient,
  projectId: string,
): Promise<LogEntryRow[]> {
  return fetchAllPages(async (from, to) => {
    const { data, error } = await supabase
      .from("schema_change_log")
      .select("id, field_name, before_value, after_value, created_at, change_type")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    return { data: data as unknown as LogEntryRow[] | null, error };
  });
}

function requireSchemaRevision(
  project: { schema_revision?: number | null } | null,
): number {
  if (!project) throw new Error("Projeto não encontrado ou sem permissão");
  if (project.schema_revision == null) {
    throw new Error("Projeto sem revisão canônica de schema");
  }
  return project.schema_revision;
}

async function runBackfill(projectId: string): Promise<BackfillSchemaResult> {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();

  const [{ data: project }, log, responses] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch, schema_revision",
      )
      .eq("id", projectId)
      .single(),
    fetchAllLogEntries(supabase, projectId),
    fetchAllResponses(supabase, projectId),
  ]);

  const expectedRevision = requireSchemaRevision(project);

  const { enriched, finalVersion } = classifyLogEntries(log);

  const snapByVersion = reconstructSnapshotsByVersion(
    ((project?.pydantic_fields as PydanticField[]) ?? []),
    enriched,
    finalVersion,
  );

  const hashesByVersion = new Map<string, Record<string, string>>();
  for (const [k, snap] of snapByVersion) {
    hashesByVersion.set(k, computeHashesFromSnapshot(snap));
  }

  const { updates, byMethod } = matchResponsesToVersions(responses, hashesByVersion, enriched);
  const stats: BackfillStats = {
    finalVersion,
    logEntriesUpdated: enriched.length,
    responsesProcessed: responses.length,
    byMethod,
  };
  const { data, error } = await supabase
    .rpc("apply_schema_backfill", {
      p_project_id: projectId,
      p_expected_revision: expectedRevision,
      p_final_major: finalVersion.major,
      p_final_minor: finalVersion.minor,
      p_final_patch: finalVersion.patch,
      p_log_updates: enriched.map((entry) => ({
        id: entry.id,
        change_type: entry.changeType,
        version_major: entry.version.major,
        version_minor: entry.version.minor,
        version_patch: entry.version.patch,
      })),
      p_response_updates: [...updates.values()].map((bucket) => ({
        ids: bucket.ids,
        version_major: bucket.version.major,
        version_minor: bucket.version.minor,
        version_patch: bucket.version.patch,
        version_inferred_from: bucket.method,
      })),
    })
    .single();
  const commit = mapCommitResult(data as SchemaCommitRow | null, error);
  if (commit.status === "error") return commit;
  if (commit.status === "conflict") return commit;
  revalidateSchemaConsumers(projectId);
  revalidatePath(`/projects/${projectId}/config/schema`);
  return { status: "saved", stats, snapshot: commit.snapshot };
}

// ---------- MAJOR version bump (manual) ----------

export async function publishMajorVersion(
  projectId: string,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaSaveResult> {
  const loaded = await loadAuthenticatedSchemaContext(projectId, expectedBaseline);
  if ("result" in loaded) return loaded.result;
  const { supabase, userId, context } = loaded;
  const typedProject = context.project;
  const current = projectVersion(typedProject);
  const bumped = bumpVersion(current, "major");
  const fields = typedProject.pydantic_fields;
  const { data, error } = await supabase
    .rpc("commit_project_schema", {
      p_project_id: projectId,
      p_expected_revision: expectedBaseline.revision,
      p_pydantic_fields: fields,
      p_pydantic_code: typedProject.pydantic_code,
      p_version_major: bumped.major,
      p_version_minor: bumped.minor,
      p_version_patch: bumped.patch,
      p_change_type: "major",
      p_log_entries: [{
        field_name: "(projeto)",
        change_summary: `Nova versão MAJOR publicada: ${versionString(bumped)}`,
        before_value: current,
        after_value: bumped,
      }],
      p_changed_by: userId,
    })
    .single();
  const result = mapCommitResult(data as SchemaCommitRow | null, error);
  if (result.status === "saved") revalidateSchemaConsumers(projectId);
  return result;
}

export async function toggleLlmField(
  projectId: string,
  fieldDef: PydanticField,
  enabled: boolean,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaSaveResult> {
  const loaded = await loadAuthenticatedSchemaContext(projectId, expectedBaseline);
  if ("result" in loaded) return loaded.result;
  let fields = loaded.context.oldFields;

  if (enabled) {
    if (!fields.some((f) => f.name === fieldDef.name)) {
      fields = [...fields, fieldDef];
    }
  } else {
    fields = fields.filter((f) => f.name !== fieldDef.name);
  }

  return persistSchema(projectId, fields, expectedBaseline, loaded);
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
