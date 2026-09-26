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

const PAGE = 1000;

// PostgREST corta em 1000 linhas por padrão; sem paginar, um projeto grande
// seria ressincronizado pela metade sem erro. A ordem por `id` é requisito da
// paginação: sem ela, a mesma linha pode cair em duas páginas ou em nenhuma.
//
// O builder fica `any` pelo mesmo motivo de `fetchAll` em
// check-invariants.ts: o PostgrestFilterBuilder muda de tipo a cada método
// encadeado, e num helper genérico por tabela o tsc estoura em TS2589.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedSelectBuilder = any;

async function fetchAll<T>(
  supabase: SupabaseServerClient,
  table: string,
  columns: string,
  projectId: string,
  filter: (query: UntypedSelectBuilder) => UntypedSelectBuilder = (q) => q,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const query: UntypedSelectBuilder = supabase.from(table).select(columns).eq("project_id", projectId);
    // A página seguinte depende de a anterior vir cheia.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const { data, error } = (await filter(query)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)) as { data: T[] | null; error: { message: string } | null };
    if (error) throw new Error(`${table}: ${error.message}`, { cause: error });
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
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

/**
 * Recalcula o status de TODOS os assignments de comparação do projeto, com a
 * mesma regra de `syncCompareAssignment`, e grava os que mudaram. Idempotente:
 * rodar duas vezes seguidas não muda nada na segunda. Com `dryRun`, só lê e
 * devolve o que mudaria.
 *
 * Quatro leituras paginadas do projeto em vez de quatro por assignment, para
 * caber no save do schema. Dentro de um documento as gravações seguem
 * `sortByReopenPriority`: só uma comparação pode estar ativa por documento, e
 * a ordem decide qual rodada reabre.
 */
export async function resyncProjectCompareAssignments(
  supabase: SupabaseServerClient,
  projectId: string,
  options: { dryRun?: boolean } = {},
): Promise<CompareResyncReport> {
  const { data: project, error: projectError } = await supabase
    .from("projects").select(COMPARE_PROJECT_SELECT).eq("id", projectId).single();
  if (projectError) throw new Error(`projects: ${projectError.message}`, { cause: projectError });
  if (!project) return { checked: 0, changes: [] };

  const assignments = await fetchAll<AssignmentRow>(
    supabase, "assignments", "id, document_id, user_id, status, completed_at", projectId,
    (q) => q.eq("type", "comparacao"));
  if (assignments.length === 0) return { checked: 0, changes: [] };

  const [responses, reviews, equivalences] = await Promise.all([
    fetchAll<ResponseRow>(supabase, "responses", COMPARE_RESPONSE_SELECT, projectId),
    fetchAll<ReviewRow>(supabase, "reviews",
      "id, document_id, reviewer_id, field_name, verdict, field_hash, chosen_response_id", projectId),
    fetchAll<EquivalenceRow>(supabase, "response_equivalences", COMPARE_EQUIVALENCE_SELECT, projectId,
      (q) => q.is("superseded_at", null)),
  ]);

  const responsesByDoc = groupBy(responses, (r) => r.document_id);
  const reviewsByDocUser = groupBy(reviews, (r) => `${r.document_id}:${r.reviewer_id}`);
  const equivalencesByDoc = groupBy(equivalences, (e) => e.document_id);

  const changesByDoc = new Map<string, Array<CompareAssignmentChange & { row: AssignmentRow }>>();
  for (const [documentId, docAssignments] of groupBy(assignments, (a) => a.document_id)) {
    for (const row of sortByReopenPriority(docAssignments)) {
      const next = compareAssignmentStatusFor({
        project: project as CompareProjectRow,
        documentId,
        responses: responsesByDoc.get(documentId) ?? [],
        reviews: reviewsByDocUser.get(`${documentId}:${row.user_id}`) ?? [],
        equivalences: equivalencesByDoc.get(documentId) ?? [],
      });
      if (next === null || next === row.status) continue;
      const change = { assignmentId: row.id, documentId, userId: row.user_id, from: row.status, to: next, row };
      const bucket = changesByDoc.get(documentId);
      if (bucket) bucket.push(change);
      else changesByDoc.set(documentId, [change]);
    }
  }

  const changes = [...changesByDoc.values()].flat().map(({ row: _row, ...change }) => change);
  if (options.dryRun) return { checked: assignments.length, changes };

  // Documentos em paralelo; dentro de um documento, em série, na ordem de
  // reabertura.
  await Promise.all([...changesByDoc.values()].map(async (docChanges) => {
    for (const change of docChanges) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await updateCompareAssignmentStatus({
        supabase, projectId, documentId: change.documentId, userId: change.userId,
        assignment: { id: change.row.id, status: change.row.status }, next: change.to,
      });
    }
  }));
  return { checked: assignments.length, changes };
}
