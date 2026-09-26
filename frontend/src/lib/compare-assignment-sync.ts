// O status do assignment de comparação a partir do estado do banco, por
// documento (`syncCompareAssignment`, em compare-sync.ts) ou para o projeto
// inteiro (`resyncProjectCompareAssignments`).
//
// O status só era recalculado quando o revisor gravava um veredito ou uma
// equivalência. Uma mudança de schema que tira a validade de vereditos
// (`review-validity.ts`) ou muda a divergência pelo piso de versão deixava o
// assignment "concluido" com campos pendentes, até alguém votar de novo no
// documento. A ressincronização do projeto roda depois de gravar o schema e,
// uma vez, pelo script `scripts/compare-assignments/resync.ts`.
//
// Fica fora de compare-sync.ts porque aquele módulo é `server-only`, e o
// script roda fora do Next. Nada aqui lê credencial: quem chama passa o
// client com a autoridade certa.
import type { SupabaseServerClient } from "@/lib/supabase/server";
import type { PydanticField } from "@/lib/types";
import { buildEquivalenceMap, type EquivalenceRow } from "@/lib/compare-divergence";
import { comparisonSet, type ComparisonCandidate } from "@/lib/comparison-set";
import {
  resolveCompareStatus,
  type CompareAssignmentStatus,
} from "@/lib/compare-assignment-status";
import { versionGate, type ProjectVersionRow } from "@/lib/compare-version";
import { reviewIsValid, type ValidatableReview } from "@/lib/review-validity";
import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";

const PG_UNIQUE_VIOLATION = "23505";
// O índice parcial criado pelo #490 (uma comparação ATIVA por documento;
// concluídas ficam fora do predicado). É o único unique de `assignments`
// alcançável por um UPDATE que só toca status/completed_at — a outra,
// UNIQUE(document_id, user_id, type), tem colunas que este UPDATE não mexe.
// Casar pelo nome mantém o skip preso a ESTA regra: um índice futuro sobre
// `status` propaga em vez de ser engolido junto.
const ACTIVE_COMPARACAO_INDEX = "assignments_one_active_comparacao_per_doc";

export const COMPARE_PROJECT_SELECT =
  "pydantic_fields, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch";
export const COMPARE_RESPONSE_SELECT =
  "id, document_id, respondent_type, respondent_id, is_latest, is_partial, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch, answers, answer_field_hashes";
export const COMPARE_EQUIVALENCE_SELECT =
  "id, document_id, field_name, response_a_id, response_b_id, reviewer_id, response_a_answer_snapshot, response_b_answer_snapshot";

export type CompareProjectRow = ProjectVersionRow & { pydantic_fields: PydanticField[] | null };

interface UpdateCompareAssignmentStatusParams {
  supabase: SupabaseServerClient;
  projectId: string;
  documentId: string;
  userId: string;
  assignment: { id: string; status: string | null };
  next: CompareAssignmentStatus;
}

/**
 * Grava o status novo. A regressão de uma comparação concluída que bate no
 * índice parcial (já há outra ativa para o documento) é preservada de
 * propósito e só registrada (#497); qualquer outro erro propaga.
 */
export async function updateCompareAssignmentStatus({
  supabase,
  projectId,
  documentId,
  userId,
  assignment,
  next,
}: UpdateCompareAssignmentStatusParams): Promise<void> {
  const { error } = await supabase
    .from("assignments")
    .update({
      status: next,
      completed_at: next === "concluido" ? new Date().toISOString() : null,
    })
    .eq("id", assignment.id);

  if (!error) return;

  if (
    error.code === PG_UNIQUE_VIOLATION &&
    error.message.includes(ACTIVE_COMPARACAO_INDEX) &&
    assignment.status === "concluido" &&
    next !== "concluido"
  ) {
    console.warn(
      `[compare-sync] ${JSON.stringify({
        event: "regression_blocked_by_active_assignment",
        projectId,
        documentId,
        assignmentId: assignment.id,
        userId,
        previousStatus: assignment.status,
        intendedStatus: next,
        errorCode: error.code,
      })}`,
    );
    return;
  }

  throw new Error(error.message, { cause: error });
}

interface ReopenCandidate {
  user_id: string;
  status: string | null;
  completed_at: string | null;
}

// Ordem de reabertura: ativa primeiro, depois concluídas da mais recente para
// a mais antiga, com `user_id` como desempate para o resultado não depender da
// ordem em que o Postgres devolveu as linhas. "Ativa" usa o MESMO predicado do
// índice parcial (status IS DISTINCT FROM 'concluido'), incluindo o status
// nulo — a coluna é NULLABLE desde o 001_initial_schema.
export function sortByReopenPriority<T extends ReopenCandidate>(rows: T[]): T[] {
  const isConcluded = (r: T) => (r.status === "concluido" ? 1 : 0);
  return [...rows].sort((a, b) => {
    const byActive = isConcluded(a) - isConcluded(b);
    if (byActive !== 0) return byActive;
    // Mais recente primeiro; `completed_at` nulo vai para o fim (não há como
    // afirmar que é a rodada corrente). Comparação lexicográfica basta: a
    // coluna é timestamptz serializada em ISO 8601 pelo PostgREST.
    const at = a.completed_at ?? "";
    const bt = b.completed_at ?? "";
    if (at !== bt) return at < bt ? 1 : -1;
    return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
  });
}

/**
 * O status que o assignment de comparação de um revisor deve ter num
 * documento, ou `null` quando não há o que decidir (menos de 2 respostas que
 * contam) e o status atual fica como está.
 *
 * Só veredito que ainda vale resolve a divergência: o mesmo critério do
 * Gabarito e da fila da Comparação (`review-validity.ts`). Um veredito dado
 * sobre outra versão da pergunta fecharia o parecer com uma célula que o
 * Gabarito não tem, e ninguém seria chamado a rearbitrá-la.
 *
 * O fecho lê a divergência a resolver do conjunto de comparação
 * (comparison-set.ts), a mesma que a fila mostra no estado default: resolver
 * tudo o que a tela mostra fecha o parecer (#217/#218). O piso é o
 * `versionGate`, o mesmo do gatilho; lentes da URL não redefinem "concluído".
 */
export function compareAssignmentStatusFor(input: {
  project: CompareProjectRow;
  documentId: string;
  /** Respostas do documento. */
  responses: readonly ComparisonCandidate[];
  /** Reviews do revisor no documento. */
  reviews: readonly ValidatableReview[];
  /** Equivalências vigentes do documento. */
  equivalences: readonly EquivalenceRow[];
}): CompareAssignmentStatus | null {
  const fields = input.project.pydantic_fields ?? [];
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const reviewedFields = new Set(
    input.reviews.flatMap((r) => (reviewIsValid(r, fieldByName.get(r.field_name)) ? [r.field_name] : [])),
  );

  const { minVersion, ctx: versionCtx } = versionGate(input.project);
  const set = comparisonSet({
    fields,
    responses: input.responses,
    minVersion,
    versionCtx,
    equivalencesByField: buildEquivalenceMap(input.equivalences).get(input.documentId),
  });

  // Sem ao menos 2 respostas que contam não há par a comparar, e a divergência
  // vazia viraria "concluido" num documento que ninguém comparou na versão
  // corrente (ex.: só codificações pré-versionamento, ou rodadas abaixo do piso
  // depois de um bump estrutural). "concluido" fica para o caso de >= 2
  // respostas com toda divergência resolvida ou fundida.
  if (set.counted.length < 2) return null;
  return resolveCompareStatus(set.toResolve, reviewedFields);
}

export interface CompareAssignmentChange {
  assignmentId: string;
  documentId: string;
  userId: string;
  from: string | null;
  to: CompareAssignmentStatus;
}

export interface CompareResyncReport {
  /** Assignments de comparação lidos. */
  checked: number;
  /** Os que mudam (ou mudariam, em `dryRun`) de status. */
  changes: CompareAssignmentChange[];
}

interface AssignmentRow extends ReopenCandidate {
  id: string;
  document_id: string;
}

interface ReviewRow extends ValidatableReview {
  document_id: string;
  reviewer_id: string | null;
}

type ResponseRow = ComparisonCandidate & { document_id: string };

// Uma leitura paginada do projeto, que falha em vez de devolver meia tabela.
function rowsOrThrow<T>(table: string, { data, error }: { data: T[]; error: { message: string } | null }): T[] {
  if (error) throw new Error(`${table}: ${error.message}`, { cause: error });
  return data;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = grouped.get(k);
    if (bucket) bucket.push(row);
    else grouped.set(k, [row]);
  }
  return grouped;
}

interface ProjectCompareState {
  project: CompareProjectRow;
  assignments: AssignmentRow[];
  responses: ResponseRow[];
  reviews: ReviewRow[];
  equivalences: EquivalenceRow[];
}

interface PlannedChange {
  change: CompareAssignmentChange;
  row: AssignmentRow;
}

// Quatro leituras paginadas do projeto em vez de quatro por assignment, para
// caber no save do schema. `null`: projeto sem assignment de comparação.
async function loadProjectCompareState(
  supabase: SupabaseServerClient,
  projectId: string,
): Promise<ProjectCompareState | null> {
  const { data: project, error } = await supabase
    .from("projects").select(COMPARE_PROJECT_SELECT).eq("id", projectId).single();
  if (error) throw new Error(`projects: ${error.message}`, { cause: error });
  if (!project) return null;

  const assignments = rowsOrThrow("assignments", await fetchAllPaged<AssignmentRow>(() => supabase
    .from("assignments").select("id, document_id, user_id, status, completed_at")
    .eq("project_id", projectId).eq("type", "comparacao"), ["id"]));
  if (assignments.length === 0) return null;

  const [responses, reviews, equivalences] = await Promise.all([
    fetchAllPaged<ResponseRow>(() => supabase
      .from("responses").select(COMPARE_RESPONSE_SELECT).eq("project_id", projectId), ["id"]),
    fetchAllPaged<ReviewRow>(() => supabase
      .from("reviews").select("id, document_id, reviewer_id, field_name, verdict, field_hash, chosen_response_id")
      .eq("project_id", projectId), ["id"]),
    fetchAllPaged<EquivalenceRow>(() => supabase
      .from("response_equivalences").select(COMPARE_EQUIVALENCE_SELECT)
      .eq("project_id", projectId).is("superseded_at", null), ["id"]),
  ]);
  return {
    project: project as CompareProjectRow,
    assignments,
    responses: rowsOrThrow("responses", responses),
    reviews: rowsOrThrow("reviews", reviews),
    equivalences: rowsOrThrow("response_equivalences", equivalences),
  };
}

// As mudanças por documento, cada lista já na ordem de reabertura.
function planCompareResync(state: ProjectCompareState): PlannedChange[][] {
  const responsesByDoc = groupBy(state.responses, (r) => r.document_id);
  const reviewsByDocUser = groupBy(state.reviews, (r) => `${r.document_id}:${r.reviewer_id}`);
  const equivalencesByDoc = groupBy(state.equivalences, (e) => e.document_id);

  const plan: PlannedChange[][] = [];
  for (const [documentId, docAssignments] of groupBy(state.assignments, (a) => a.document_id)) {
    const docPlan: PlannedChange[] = [];
    for (const row of sortByReopenPriority(docAssignments)) {
      const next = compareAssignmentStatusFor({
        project: state.project,
        documentId,
        responses: responsesByDoc.get(documentId) ?? [],
        reviews: reviewsByDocUser.get(`${documentId}:${row.user_id}`) ?? [],
        equivalences: equivalencesByDoc.get(documentId) ?? [],
      });
      if (next === null || next === row.status) continue;
      docPlan.push({ change: { assignmentId: row.id, documentId, userId: row.user_id, from: row.status, to: next }, row });
    }
    if (docPlan.length > 0) plan.push(docPlan);
  }
  return plan;
}

// Documentos em paralelo; dentro de um documento, em série, na ordem de
// reabertura: só uma comparação pode estar ativa por documento, e a ordem
// decide qual rodada reabre.
async function applyCompareResync(
  supabase: SupabaseServerClient,
  projectId: string,
  plan: PlannedChange[][],
): Promise<void> {
  await Promise.all(plan.map(async (docPlan) => {
    for (const { change, row } of docPlan) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await updateCompareAssignmentStatus({
        supabase, projectId, documentId: change.documentId, userId: change.userId,
        assignment: { id: row.id, status: row.status }, next: change.to,
      });
    }
  }));
}

/**
 * Recalcula o status de TODOS os assignments de comparação do projeto, com a
 * mesma regra de `syncCompareAssignment`, e grava os que mudaram. Idempotente:
 * rodar duas vezes seguidas não muda nada na segunda. Com `dryRun`, só lê e
 * devolve o que mudaria.
 */
export async function resyncProjectCompareAssignments(
  supabase: SupabaseServerClient,
  projectId: string,
  options: { dryRun?: boolean } = {},
): Promise<CompareResyncReport> {
  const state = await loadProjectCompareState(supabase, projectId);
  if (!state) return { checked: 0, changes: [] };
  const plan = planCompareResync(state);
  const changes = plan.flat().map(({ change }) => change);
  if (options.dryRun) return { checked: state.assignments.length, changes };
  await applyCompareResync(supabase, projectId, plan);
  return { checked: state.assignments.length, changes };
}
