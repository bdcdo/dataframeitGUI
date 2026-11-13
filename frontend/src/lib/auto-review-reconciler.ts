import "server-only";

import { computeBacklogRows, type HumanResponseRow, type LlmResponseRow } from "@/lib/auto-review-backlog";
import {
  currentValueEquivalences,
  equivalencesInClassesOf,
  groupValueEquivalencesByField,
  type ValueEquivalencesByField,
} from "@/lib/equivalence";
import { fetchProjectValueEquivalences } from "@/lib/value-equivalence-query";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import type { PydanticField } from "@/lib/types";

interface ReconciliationRequest {
  project_id: string;
  document_id: string;
  // Nunca nulo desde a #670: a coluna é NOT NULL e o produtor não enfileira
  // documento sem geração LLM corrente. Antes disso, NULL significava "humano
  // sujo esperando a primeira geração" — um estado que nenhum worker conseguia
  // satisfazer e que ficava em retry perpétuo.
  llm_response_id: string;
  // Token de versão da request, não metadado de exibição: os dois produtores o
  // reescrevem com `now()` no `ON CONFLICT DO UPDATE`, e o ACK o exige de volta
  // para não apagar um reenfileiramento que chegou depois da leitura.
  requested_at: string;
  allow_new_cycles: boolean;
}

interface ReconciliationGroup {
  human_response_id: string;
  llm_response_id: string;
  field_names: string[];
  divergent_field_names: string[];
  expected_human_updated_at: string;
  expected_llm_updated_at: string;
  expected_project_pydantic_hash: string | null;
  expected_equivalence_ids: string[];
}

type AdminClient = ReturnType<typeof createSupabaseAdmin>;
type VersionedHumanResponse = HumanResponseRow & { updated_at: string };
type VersionedLlmResponse = LlmResponseRow & { updated_at: string };
type ReconciliationOutcome = "processed" | "stale" | "failed";

interface ReconciliationInputs {
  fields: PydanticField[];
  pydanticHash: string | null;
  humans: VersionedHumanResponse[];
  llm: VersionedLlmResponse | null;
  equivalencesByField: ValueEquivalencesByField;
}

export interface ReconciliationDrainResult {
  processed: number;
  stale: number;
  failed: number;
  remaining: number;
}

function firstError(
  results: Array<{ error: { message: string } | null }>,
): { message: string } | null {
  return results.find((result) => result.error)?.error ?? null;
}

async function acknowledge(
  admin: AdminClient,
  request: ReconciliationRequest,
): Promise<void> {
  // ACK pela linha exata que este worker leu, e são precisos os dois filtros:
  // `llm_response_id` cobre a republicação de LLM (que troca a geração), e
  // `requested_at` cobre o reenfileiramento HUMANO, que mantém a mesma geração e
  // por isso é invisível ao primeiro filtro — o `ON CONFLICT (document_id) DO
  // UPDATE` dos dois produtores só reescreve `requested_at`/`attempt_count`.
  // Sem o segundo filtro, um save que caia entre o commit de
  // reconcile_auto_review_cycles e este DELETE perde a request recém-criada,
  // ficando com os field_reviews arquivados e nada na fila para regenerá-los.
  // `record_auto_review_reconciliation_failure` não toca em `requested_at`, então
  // uma tentativa que falhou antes ainda casa aqui: o filtro não prende a fila.
  const { error } = await admin
    .from("auto_review_reconciliation_requests")
    .delete()
    .eq("document_id", request.document_id)
    .eq("llm_response_id", request.llm_response_id)
    .eq("requested_at", request.requested_at);
  if (error) throw new Error(error.message);
}

async function recordFailure(
  admin: AdminClient,
  request: ReconciliationRequest,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const { error: updateError } = await admin.rpc(
    "record_auto_review_reconciliation_failure",
    {
      p_document_id: request.document_id,
      p_llm_response_id: request.llm_response_id,
      p_error: message,
    },
  );
  if (updateError) {
    console.error(
      `[auto-review] ${JSON.stringify({
        event: "reconciliation_failure_record_failed",
        projectId: request.project_id,
        documentId: request.document_id,
        llmResponseId: request.llm_response_id,
        error: updateError.message,
      })}`,
    );
  }
}

function collectDependencyIds(
  currentRows: Array<{ self_reviewer_id: string }>,
  historyRows: Array<{ self_reviewer_id: string }>,
  aliases: Array<{ member_user_id: string; linked_user_id: string }>,
): Set<string> {
  const dependencyIds = new Set(
    [...currentRows, ...historyRows].map((row) => row.self_reviewer_id),
  );
  for (const alias of aliases) {
    if (dependencyIds.has(alias.member_user_id)) {
      dependencyIds.add(alias.linked_user_id);
    }
    if (dependencyIds.has(alias.linked_user_id)) {
      dependencyIds.add(alias.member_user_id);
    }
  }
  return dependencyIds;
}

async function eligibleHumanResponses(
  admin: AdminClient,
  request: ReconciliationRequest,
  humans: VersionedHumanResponse[],
): Promise<VersionedHumanResponse[]> {
  const membersResult = await admin
    .from("project_members")
    .select("user_id")
    .eq("project_id", request.project_id);
  if (membersResult.error) throw new Error(membersResult.error.message);
  const memberIds = new Set(
    (membersResult.data ?? []).map((member) => member.user_id),
  );
  const currentHumans = humans.filter((human) =>
    memberIds.has(human.respondent_id)
  );
  if (request.allow_new_cycles) return currentHumans;

  const [currentResult, historyResult, aliasesResult] = await Promise.all([
    admin
      .from("field_reviews")
      .select("self_reviewer_id")
      .eq("project_id", request.project_id)
      .eq("document_id", request.document_id),
    admin
      .from("field_review_cycle_history_entries")
      .select("self_reviewer_id")
      .eq("project_id", request.project_id)
      .eq("document_id", request.document_id),
    admin
      .from("member_email_links")
      .select("member_user_id, linked_user_id")
      .eq("project_id", request.project_id),
  ]);
  const readError = firstError([currentResult, historyResult, aliasesResult]);
  if (readError) throw new Error(readError.message);

  const dependencyIds = collectDependencyIds(
    currentResult.data ?? [],
    historyResult.data ?? [],
    aliasesResult.data ?? [],
  );
  return currentHumans.filter((human) => dependencyIds.has(human.respondent_id));
}

// As equivalências de valor são do projeto, não do documento: uma drenagem lê
// uma vez por projeto e reusa. Ler uma lista desatualizada é seguro pela
// mesma razão de `expectedEquivalenceIds` (desfeita no meio recusa na RPC;
// criada no meio reenfileira o documento).
// Guarda o mapa por campo, e não a lista: as listas mantêm a identidade entre
// requests, e o recorte por versão e as classes (memoizados por identidade em
// `lib/equivalence.ts`) são calculados uma vez por drenagem.
type EquivalenceCache = Map<string, Promise<ValueEquivalencesByField>>;

function projectEquivalences(
  admin: AdminClient,
  projectId: string,
  cache: EquivalenceCache,
): Promise<ValueEquivalencesByField> {
  let pending = cache.get(projectId);
  if (!pending) {
    pending = fetchProjectValueEquivalences(admin, projectId).then((result) => {
      if (result.error) throw new Error(result.error.message);
      return groupValueEquivalencesByField(result.data);
    });
    // Falha não fica no cache: a próxima request do lote tenta de novo.
    pending.catch(() => cache.delete(projectId));
    cache.set(projectId, pending);
  }
  return pending;
}

async function readReconciliationInputs(
  admin: AdminClient,
  request: ReconciliationRequest,
  equivalenceCache: EquivalenceCache,
): Promise<ReconciliationInputs> {
  const [projectResult, humansResult, llmResult, equivalencesResult] =
    await Promise.all([
      admin
        .from("projects")
        .select("pydantic_fields, pydantic_hash")
        .eq("id", request.project_id)
        .single(),
      admin
        .from("responses")
        .select("id, document_id, respondent_id, answers, answer_field_hashes, updated_at")
        .eq("project_id", request.project_id)
        .eq("document_id", request.document_id)
        .eq("respondent_type", "humano")
        .eq("is_latest", true)
        .eq("is_partial", false),
      // O filtro por id é o que distingue "a geração que enfileirou este pedido
      // continua corrente" de "outra publicação já a substituiu". Sem ele, uma
      // request obsoleta reconciliaria contra a geração nova, com os
      // `expected_*` da antiga.
      admin
        .from("responses")
        .select("id, document_id, answers, answer_field_hashes, updated_at")
        .eq("project_id", request.project_id)
        .eq("document_id", request.document_id)
        .eq("respondent_type", "llm")
        .eq("is_latest", true)
        .eq("is_partial", false)
        .eq("id", request.llm_response_id)
        .maybeSingle(),
      projectEquivalences(admin, request.project_id, equivalenceCache),
    ]);
  const readError = firstError([projectResult, humansResult, llmResult]);
  if (readError) throw new Error(readError.message);

  return {
    fields: (projectResult.data?.pydantic_fields ?? []) as PydanticField[],
    pydanticHash: projectResult.data?.pydantic_hash ?? null,
    humans: (humansResult.data ?? []) as VersionedHumanResponse[],
    llm: llmResult.data as VersionedLlmResponse | null,
    equivalencesByField: equivalencesResult,
  };
}

function divergentFieldsByHuman(
  fieldReviewRows: Array<{ human_response_id: string; field_name: string }>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of fieldReviewRows) {
    const names = result.get(row.human_response_id) ?? [];
    names.push(row.field_name);
    result.set(row.human_response_id, names);
  }
  return result;
}

// As equivalências que este worker usou para o par humano/LLM: as das classes
// dos valores de cada um, campo a campo, na versão atual da pergunta. A RPC
// recusa a reconciliação se alguma delas foi desfeita no meio. Equivalência
// criada no meio não precisa recusar: a propagação dela reenfileira o
// documento com outro `requested_at`, que o ACK desta leitura não apaga. O
// recorte por documento evita que um "=" noutro documento derrube toda
// reconciliação em curso no projeto.
export function expectedEquivalenceIds(
  equivalencesByField: ValueEquivalencesByField,
  fields: readonly PydanticField[],
  humanAnswers: Record<string, unknown> | null,
  llmAnswers: Record<string, unknown> | null,
): string[] {
  return fields
    .flatMap((field) =>
      equivalencesInClassesOf(
        currentValueEquivalences(equivalencesByField.get(field.name), field),
        [humanAnswers?.[field.name], llmAnswers?.[field.name]].filter((value) => value !== undefined),
      ),
    )
    .map((equivalence) => equivalence.id)
    .sort();
}

function buildReconciliationGroups(
  inputs: Omit<ReconciliationInputs, "llm"> & { llm: VersionedLlmResponse },
  humans: VersionedHumanResponse[],
  fieldReviewRows: Array<{ human_response_id: string; field_name: string }>,
): ReconciliationGroup[] {
  const divergentFields = divergentFieldsByHuman(fieldReviewRows);
  const fieldNames = inputs.fields.map((field) => field.name);
  return humans.map((human) => ({
    human_response_id: human.id,
    llm_response_id: inputs.llm.id,
    field_names: fieldNames,
    divergent_field_names: divergentFields.get(human.id) ?? [],
    expected_human_updated_at: human.updated_at,
    expected_llm_updated_at: inputs.llm.updated_at,
    expected_project_pydantic_hash: inputs.pydanticHash,
    expected_equivalence_ids: expectedEquivalenceIds(
      inputs.equivalencesByField,
      inputs.fields,
      human.answers,
      inputs.llm.answers,
    ),
  }));
}

async function reconcileRequest(
  admin: AdminClient,
  request: ReconciliationRequest,
  equivalenceCache: EquivalenceCache,
): Promise<"processed" | "stale"> {
  const inputs = await readReconciliationInputs(admin, request, equivalenceCache);
  const llm = inputs.llm;
  // A geração enfileirada deixou de ser a corrente e completa (rerun, publicação
  // parcial, remoção). O pedido é obsoleto: quem publicar a próxima geração
  // reenfileira o documento. Desde a #670 não existe mais o caso "ainda não há
  // geração nenhuma" — a request não seria criada.
  if (!llm) {
    await acknowledge(admin, request);
    return "stale";
  }

  const humans = await eligibleHumanResponses(
    admin,
    request,
    inputs.humans,
  );
  const llmByDocument = new Map([[request.document_id, llm]]);
  const { fieldReviewRows } = computeBacklogRows(
    request.project_id,
    humans,
    llmByDocument,
    inputs.equivalencesByField,
    inputs.fields,
  );
  const groups = buildReconciliationGroups({ ...inputs, llm }, humans, fieldReviewRows);

  if (groups.length > 0) {
    const { error } = await admin.rpc("reconcile_auto_review_cycles", {
      p_groups: groups,
    });
    if (error) throw new Error(error.message);
  }
  await acknowledge(admin, request);
  return "processed";
}

function logReconciliationFailure(
  request: ReconciliationRequest,
  error: unknown,
): void {
  console.error(
    `[auto-review] ${JSON.stringify({
      event: "reconciliation_failed",
      projectId: request.project_id,
      documentId: request.document_id,
      llmResponseId: request.llm_response_id,
      error: error instanceof Error ? error.message : String(error),
    })}`,
  );
}

async function processRequest(
  admin: AdminClient,
  request: ReconciliationRequest,
  equivalenceCache: EquivalenceCache,
): Promise<ReconciliationOutcome> {
  try {
    return await reconcileRequest(admin, request, equivalenceCache);
  } catch (requestError) {
    await recordFailure(admin, request, requestError);
    logReconciliationFailure(request, requestError);
    return "failed";
  }
}

async function fetchDueRequests(
  admin: AdminClient,
  batchSize: number,
  projectId?: string,
): Promise<ReconciliationRequest[]> {
  let query = admin
    .from("auto_review_reconciliation_requests")
    .select("project_id, document_id, llm_response_id, requested_at, allow_new_cycles")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .order("requested_at", { ascending: true })
    .limit(batchSize);
  if (projectId) query = query.eq("project_id", projectId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as ReconciliationRequest[];
}

async function countDueRequests(
  admin: AdminClient,
  projectId?: string,
): Promise<number> {
  let query = admin
    .from("auto_review_reconciliation_requests")
    .select("document_id", { count: "exact", head: true })
    .lte("next_attempt_at", new Date().toISOString());
  if (projectId) query = query.eq("project_id", projectId);
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

function processedRequestCount(result: ReconciliationDrainResult): number {
  return result.processed + result.stale + result.failed;
}

export async function drainAutoReviewReconciliationRequests(
  options: { batchSize?: number; maxRequests?: number; projectId?: string } = {},
): Promise<ReconciliationDrainResult> {
  const admin = createSupabaseAdmin();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 100));
  const maxRequests = Math.max(batchSize, Math.min(options.maxRequests ?? 500, 2_000));
  const result: ReconciliationDrainResult = {
    processed: 0,
    stale: 0,
    failed: 0,
    remaining: 0,
  };
  const equivalenceCache: EquivalenceCache = new Map();

  while (processedRequestCount(result) < maxRequests) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const requests = await fetchDueRequests(admin, batchSize, options.projectId);

    for (const request of requests) {
      // Sequential processing bounds DB pressure. Duplicate workers remain safe
      // because reconciliation is versioned by the RPC's expected_* inputs and
      // the ACK matches the exact request row (generation + requested_at).
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const outcome = await processRequest(admin, request, equivalenceCache);
      result[outcome] += 1;
    }
    if (requests.length < batchSize) break;
  }

  result.remaining = await countDueRequests(admin, options.projectId);
  return result;
}
