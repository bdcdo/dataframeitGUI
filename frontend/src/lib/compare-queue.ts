// Carregador da fila de comparação (analyze/compare/page.tsx), #751.
//
// `loadCompareQueue` faz as buscas no Supabase e compõe, em ordem, as funções
// puras deste arquivo (extraídas do Server Component no #388) até as props de
// <ComparePage>. As funções são internas: a composição é o que tem contrato, e
// é por ela que os testes entram, para que mexer na ordem (o que alimenta o
// quê) quebre um teste. A página fica com autenticação, erro e render.

import {
  currentValueEquivalences,
  groupValueEquivalencesByField,
  type ValueEquivalence,
  type ValueEquivalencesByField,
} from "@/lib/equivalence";
import { comparisonSet, type ComparisonSet } from "@/lib/comparison-set";
import {
  assignedCompareDocIds,
  compareDefaultsForMode,
  readCompareFilters,
  resolveShowAllQueue,
  type CompareFiltersValue,
} from "@/lib/compare-filters";
import {
  type ProjectVersionContext,
  type SchemaVersion,
  formatVersion,
  compareVersions,
  deriveProjectVersionContext,
  latestMajorAnchor,
  resolveMinVersion,
  responseVersionLabel,
  storedVersion,
} from "@/lib/compare-version";
import type { resolveProjectQueueIdentity } from "@/lib/auth";
import type { ReviewsByDoc, StaleReviewsByDoc } from "@/lib/compare-reviews";
import { reviewValidity } from "@/lib/review-validity";
import { serverErrorScope } from "@/lib/server-error";
import { fetchAllAfterId, fetchByDocumentChunks } from "@/lib/supabase/fetch-all-paged";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import type { PydanticField } from "@/lib/types";
import { fetchProjectValueEquivalences } from "@/lib/value-equivalence-query";
import type { CompareResponse, DocCoverage } from "@/components/compare/compare-types";

interface CompareDoc {
  id: string;
  title: string | null;
  external_id: string | null;
  text: string;
}

// A row da fila é o tipo wire (`CompareResponse`, o mesmo que <ComparePage>
// recebe na prop `responses`) mais o `document_id`, que a query traz e o
// agrupamento por documento usa. O `extends` é o que impede o drift: antes os
// dois shapes eram declarados campo a campo em módulos diferentes sob o mesmo
// nome, e já tinham divergido — o wire ficou sem `document_id` enquanto o mesmo
// objeto atravessava a fronteira RSC -> client em `compare/page.tsx`
// (`responsesMap` sai daqui e entra na prop tipada com o wire), compilando em
// silêncio porque no call site não é object literal e não há excess property
// check.
interface CompareQueueResponse extends CompareResponse {
  document_id: string;
}

// A cobertura que a qualificação do documento consegue medir: tudo menos o
// `reviewedCount`, que depende dos vereditos buscados depois dela (ver
// `buildReviewsAndReviewedCounts`).
type QualifiedCoverage = Omit<DocCoverage, "reviewedCount">;

// Row solta o suficiente para aceitar o resultado do select do Supabase (que
// também traz o join `documents`, cujo tipo inferido não bate 1:1 com
// Omit<CompareDoc, "text">) sem replicar seu tipo inferido — mesma pragmática
// do `as unknown as CompareQueueResponse` abaixo. Sem index signature de
// propósito: bastam os campos abaixo (structural typing ignora os demais
// campos da row), e um index signature exigiria o mesmo em qualquer valor
// passado.
interface RawResponseRow extends ResponseLabelRow {
  document_id: string;
  documents?: unknown;
}

// O que `respondentNames` e `availableVersions` leem de cada resposta. Valem
// para o histórico todo (inclusive `is_latest = false`), que a qualificação
// descarta: por isso as respostas substituídas vêm só com estas colunas, e não
// com `answers`/`justifications` (ver a leitura em `loadCompareQueue`).
interface ResponseLabelRow {
  id: string;
  respondent_name: string | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
}

interface VersionLogRow {
  id: string;
  version_major: number | null;
  version_minor: number | null;
  version_patch: number | null;
}

interface AssignmentRow {
  id: string;
  document_id: string;
  user_id: string;
  type: string;
  status: string;
}

interface ReviewRow {
  id: string;
  document_id: string;
  field_name: string;
  verdict: string;
  chosen_response_id: string | null;
  comment: string | null;
  reviewer_id: string | null;
  /** `reviews.field_hash`: o hash do campo quando a arbitragem foi feita. */
  field_hash: string | null;
}

interface CommentCountRow {
  id: string;
  document_id: string | null;
  field_name: string | null;
}

interface SuggestionCountRow {
  id: string;
  field_name: string;
}

function indexResponsesByDoc(allResponses: readonly RawResponseRow[] | null): {
  responsesByDoc: Map<string, CompareQueueResponse[]>;
  docsMetaMap: Map<string, Omit<CompareDoc, "text">>;
} {
  const responsesByDoc = new Map<string, CompareQueueResponse[]>();
  const docsMetaMap = new Map<string, Omit<CompareDoc, "text">>();

  allResponses?.forEach((r) => {
    const docId = r.document_id;
    if (!responsesByDoc.has(docId)) responsesByDoc.set(docId, []);
    responsesByDoc.get(docId)!.push(r as unknown as CompareQueueResponse);
    // `documents` é 1:1 por doc (join pela FK document_id) — grava só na
    // primeira ocorrência em vez de sobrescrever a cada resposta do mesmo doc.
    if (r.documents && !docsMetaMap.has(docId)) {
      docsMetaMap.set(docId, r.documents as unknown as Omit<CompareDoc, "text">);
    }
  });

  return { responsesByDoc, docsMetaMap };
}

// Respondent names list (do conjunto todo, antes de filtrar)
function extractRespondentNames(allResponses: readonly ResponseLabelRow[] | null): string[] {
  return [
    ...new Set(
      allResponses?.flatMap((r) => (r.respondent_name ? [r.respondent_name] : [])) ?? [],
    ),
  ];
}

// Build distinct ordered version list desc — une versões do schema_change_log
// com as efetivamente gravadas em responses (cobre respostas cuja versão veio
// do backfill por hashes/created_at e não tem entry classificada no log).
function buildAvailableVersions(
  versionLog: readonly VersionLogRow[] | null,
  allResponses: readonly ResponseLabelRow[] | null,
): string[] {
  const versionSet = new Set<string>();
  for (const v of versionLog ?? []) {
    const version = storedVersion(v.version_major, v.version_minor, v.version_patch);
    if (version) versionSet.add(formatVersion(version));
  }
  for (const r of allResponses ?? []) {
    const label = responseVersionLabel(r);
    if (label) versionSet.add(label);
  }
  return Array.from(versionSet).toSorted((a, b) => compareVersions(b, a));
}

// Coding-type assignments map per doc (denominator for % atribuídos)
function buildCodingAssignedByDoc(
  allAssignments: readonly AssignmentRow[] | null,
): Map<string, Set<string>> {
  const codingAssignedByDoc = new Map<string, Set<string>>();
  for (const a of allAssignments ?? []) {
    if (a.type !== "codificacao") continue;
    if (!codingAssignedByDoc.has(a.document_id)) {
      codingAssignedByDoc.set(a.document_id, new Set());
    }
    codingAssignedByDoc.get(a.document_id)!.add(a.user_id);
  }
  return codingAssignedByDoc;
}

// Status per user-doc for compare assignment (used in list and panel).
// showAll (coordenador na aba "Todos") não tem um único assignment individual
// de referência — mapa vazio. Na aba "Meus" (showAll=false), vale tanto para
// coordenador quanto para não-coordenador: mesmo filtro por user_id.
function buildCompareAssignmentStatusByDoc(
  allAssignments: readonly AssignmentRow[] | null,
  showAll: boolean,
  userId: string,
): Map<string, "pendente" | "em_andamento" | "concluido"> {
  const compareAssignmentStatusByDoc = new Map<
    string,
    "pendente" | "em_andamento" | "concluido"
  >();
  if (showAll) return compareAssignmentStatusByDoc;
  for (const a of allAssignments ?? []) {
    if (a.type !== "comparacao" || a.user_id !== userId) continue;
    compareAssignmentStatusByDoc.set(
      a.document_id,
      a.status as "pendente" | "em_andamento" | "concluido",
    );
  }
  return compareAssignmentStatusByDoc;
}

interface QualifyDocumentsContext {
  compareAssignedDocIds: Set<string> | null;
  codingAssignedByDoc: Map<string, Set<string>>;
  compareAssignmentStatusByDoc: Map<string, "pendente" | "em_andamento" | "concluido">;
  filters: CompareFiltersValue;
  minVersion: SchemaVersion | null;
  projectVersionCtx: ProjectVersionContext;
  sinceMs: number | null;
  fields: PydanticField[];
  equivalencesByField: ValueEquivalencesByField;
}

interface QualifiedDocumentsResult {
  qualifiedDocIds: string[];
  divergentFields: Record<string, string[]>;
  responsesMap: Record<string, CompareQueueResponse[]>;
  coverageByDoc: Record<string, QualifiedCoverage>;
}

// Lentes efêmeras da URL (since/respondent). Aplicadas antes do conjunto de
// comparação, que decide versão, completude e divergência; ver
// comparison-set.ts.
function applyQueueLens(
  docResponses: CompareQueueResponse[],
  sinceMs: number | null,
  respondentFilter: string,
): CompareQueueResponse[] {
  return docResponses.filter((r) => {
    if (sinceMs !== null && new Date(r.created_at).getTime() < sinceMs) return false;
    return respondentFilter === "all" || r.respondent_name === respondentFilter;
  });
}

interface CoverageMetrics {
  humanCount: number;
  totalCount: number;
  assignedCodingCount: number;
  humansFromAssigned: number;
  pct: number;
}

function computeCoverageMetrics(
  set: ComparisonSet<CompareQueueResponse>,
  assignedUsers: Set<string>,
): CoverageMetrics {
  const qualifiedResponses = set.counted;
  const humanCount = set.humanRespondentCount;
  const totalCount = qualifiedResponses.length;
  const assignedCodingCount = assignedUsers.size;
  const humansFromAssigned = new Set(
    qualifiedResponses
      .filter(
        (r) =>
          r.respondent_type === "humano" && r.respondent_id && assignedUsers.has(r.respondent_id),
      )
      .map((r) => r.respondent_id),
  ).size;
  const pct =
    assignedCodingCount === 0 ? 100 : Math.round((humansFromAssigned / assignedCodingCount) * 100);
  return { humanCount, totalCount, assignedCodingCount, humansFromAssigned, pct };
}

function meetsCoverageThresholds(metrics: CoverageMetrics, filters: CompareFiltersValue): boolean {
  if (metrics.humanCount < filters.minHumans) return false;
  if (metrics.totalCount < filters.minTotal) return false;
  // O gate de "% atribuídos que responderam" só faz sentido quando se espera
  // ≥ 2 humanos. Em compare_llm (piso de 1 humano + LLM) ele esconderia docs
  // de 1 codificador onde há mais de um atribuído — fora do que o gatilho de
  // comparação exige. Aplica-se só quando o piso de humanos é ≥ 2.
  if (
    filters.minHumans >= 2 &&
    metrics.assignedCodingCount > 0 &&
    metrics.pct < filters.minAssignedPct
  ) {
    return false;
  }
  return true;
}

interface QualifiedDocument {
  qualifiedResponses: CompareQueueResponse[];
  divergent: string[];
  coverage: QualifiedCoverage;
}

function qualifyDocument(
  docId: string,
  docResponses: CompareQueueResponse[],
  ctx: QualifyDocumentsContext,
): QualifiedDocument | null {
  const set = comparisonSet({
    fields: ctx.fields,
    responses: applyQueueLens(docResponses, ctx.sinceMs, ctx.filters.respondent),
    minVersion: ctx.minVersion,
    versionCtx: ctx.projectVersionCtx,
    equivalencesByField: ctx.equivalencesByField,
  });
  const assignedUsers = ctx.codingAssignedByDoc.get(docId) ?? new Set<string>();
  const metrics = computeCoverageMetrics(set, assignedUsers);

  if (!meetsCoverageThresholds(metrics, ctx.filters)) return null;

  const divergent = set.toResolve;
  if (divergent.length === 0) return null;

  return {
    qualifiedResponses: set.counted,
    divergent,
    coverage: {
      docId,
      humanCount: metrics.humanCount,
      totalCount: metrics.totalCount,
      assignedCodingCount: metrics.assignedCodingCount,
      humansFromAssigned: metrics.humansFromAssigned,
      divergentCount: divergent.length,
      assignmentStatus: ctx.compareAssignmentStatusByDoc.get(docId) ?? null,
    },
  };
}

function qualifyDocumentsForCompare(
  responsesByDoc: Map<string, CompareQueueResponse[]>,
  docsMetaMap: Map<string, Omit<CompareDoc, "text">>,
  ctx: QualifyDocumentsContext,
): QualifiedDocumentsResult {
  const qualifiedDocIds: string[] = [];
  const divergentFields: Record<string, string[]> = {};
  const responsesMap: Record<string, CompareQueueResponse[]> = {};
  const coverageByDoc: Record<string, QualifiedCoverage> = {};

  for (const [docId, docResponses] of responsesByDoc) {
    if (ctx.compareAssignedDocIds && !ctx.compareAssignedDocIds.has(docId)) continue;
    if (!docsMetaMap.has(docId)) continue;

    const result = qualifyDocument(docId, docResponses, ctx);
    if (!result) continue;

    qualifiedDocIds.push(docId);
    divergentFields[docId] = result.divergent;
    responsesMap[docId] = result.qualifiedResponses;
    coverageByDoc[docId] = result.coverage;
  }

  return { qualifiedDocIds, divergentFields, responsesMap, coverageByDoc };
}

// textMap só contém docs com excluded_at IS NULL (filtrado na query). Usar
// como gate final garante que docs soft-deletados saiam da comparação por
// completo, não apenas com texto vazio.
function buildDocumentsForCompare(
  qualifiedDocIds: string[],
  textMap: Map<string, string>,
  docsMetaMap: Map<string, Omit<CompareDoc, "text">>,
): CompareDoc[] {
  return qualifiedDocIds
    .filter((docId) => textMap.has(docId))
    .map((docId) => {
      const meta = docsMetaMap.get(docId)!;
      return { ...meta, text: textMap.get(docId) || "" };
    });
}

// Vereditos da identidade efetiva e, a partir deles, a cobertura final de
// cada documento qualificado: a medida na qualificação mais o `reviewedCount`,
// quantas das divergências do documento ela já revisou.
function buildReviewsAndReviewedCounts(
  reviews: readonly ReviewRow[] | null,
  userId: string,
  qualifiedCoverageByDoc: Record<string, QualifiedCoverage>,
  divergentFields: Record<string, string[]>,
  fieldByName: ReadonlyMap<string, PydanticField>,
): {
  existingReviews: ReviewsByDoc;
  /**
   * Vereditos do revisor que perderam a validade (`review-validity.ts`): a
   * pergunta mudou depois deles, ou o valor saiu das opções. Não contam como
   * revisados, e a célula volta a pedir arbitragem; a tela os mostra só como
   * referência.
   */
  staleReviews: StaleReviewsByDoc;
  coverageByDoc: Record<string, DocCoverage>;
} {
  const existingReviews: ReviewsByDoc = {};
  const staleReviews: StaleReviewsByDoc = {};

  // A revisão da Comparação é POR REVISOR (UNIQUE inclui reviewer_id, e
  // syncCompareAssignment fecha o assignment contando só os reviews do
  // usuário). Por isso `existingReviews` — que semeia `localReviews` e decide
  // "campo/doc já revisado" na UI — considera SÓ a identidade efetiva, igual
  // ao reviewedCount. Semear com vereditos de terceiros (comportamento antigo)
  // marcava docs revisados por outro revisor como "Revisão concluída" na tela
  // de quem nunca os revisou: o teclado de voto era bloqueado e o assignment
  // nunca fechava — o parecer travava na fila (bug relatado em 2026-07-10).
  //
  // Veredito que perdeu a validade vai para `staleReviews` e não conta: o
  // mesmo critério do Gabarito e do fecho (`syncCompareAssignment`), senão o
  // campo apareceria "já revisado" aqui enquanto some do Gabarito.
  //
  // E só os documentos da fila: o cliente não usa veredito de documento que
  // não lista, e o reviewedCount só é medido nos qualificados.
  const myReviewsByDoc = new Map<string, Set<string>>();
  reviews?.forEach((r) => {
    if (r.reviewer_id !== userId) return;
    if (!Object.hasOwn(qualifiedCoverageByDoc, r.document_id)) return;
    const info = {
      verdict: r.verdict,
      chosenResponseId: r.chosen_response_id ?? null,
      comment: r.comment ?? null,
    };
    const validity = reviewValidity(r, fieldByName.get(r.field_name));
    if (!validity.valid) {
      (staleReviews[r.document_id] ??= {})[r.field_name] = { ...info, invalidReason: validity.reason };
      return;
    }
    (existingReviews[r.document_id] ??= {})[r.field_name] = info;
    let reviewedFields = myReviewsByDoc.get(r.document_id);
    if (!reviewedFields) {
      reviewedFields = new Set();
      myReviewsByDoc.set(r.document_id, reviewedFields);
    }
    reviewedFields.add(r.field_name);
  });

  const coverageByDoc: Record<string, DocCoverage> = {};
  for (const [docId, coverage] of Object.entries(qualifiedCoverageByDoc)) {
    const reviewed = myReviewsByDoc.get(docId) ?? new Set<string>();
    const divergent = divergentFields[docId] ?? [];
    coverageByDoc[docId] = {
      ...coverage,
      reviewedCount: divergent.filter((fn) => reviewed.has(fn)).length,
    };
  }

  return { existingReviews, staleReviews, coverageByDoc };
}

// Build comment+suggestion counts by (doc, field)
//
// Só os comentários dos documentos da fila: o cliente lê a contagem pelo
// documento exibido (`fieldCommentCountOf`). O filtro aqui também impede que
// uma linha inesperada entre no payload, além do recorte feito na consulta.
function buildCountsByKey(
  commentCounts: readonly CommentCountRow[] | null,
  suggestionCounts: readonly SuggestionCountRow[] | null,
  queueDocIds: ReadonlySet<string>,
): {
  commentCountsByKey: Record<string, number>;
  suggestionCountsByField: Record<string, number>;
} {
  const commentCountsByKey: Record<string, number> = {};
  for (const c of commentCounts ?? []) {
    if (c.document_id === null || !queueDocIds.has(c.document_id)) continue;
    const key = `${c.document_id}|${c.field_name ?? ""}`;
    commentCountsByKey[key] = (commentCountsByKey[key] ?? 0) + 1;
  }
  const suggestionCountsByField: Record<string, number> = {};
  for (const s of suggestionCounts ?? []) {
    suggestionCountsByField[s.field_name] = (suggestionCountsByField[s.field_name] ?? 0) + 1;
  }
  return { commentCountsByKey, suggestionCountsByField };
}

// Sort docs: most unreviewed divergences first.
function sortDocumentsByPendingDivergence(
  documents: CompareDoc[],
  coverageByDoc: Record<string, DocCoverage>,
): CompareDoc[] {
  return documents.toSorted((a, b) => {
    const ca = coverageByDoc[a.id];
    const cb = coverageByDoc[b.id];
    const pendA = ca.divergentCount - ca.reviewedCount;
    const pendB = cb.divergentCount - cb.reviewedCount;
    return pendB - pendA;
  });
}

// Serialize equivalences for the client component (Maps don't cross the RSC
// boundary). Only the current question version of each field ships: an
// equivalence of another version fuses nothing, and values can be long texts.
function serializeEquivalencesForClient(
  equivalencesByField: ValueEquivalencesByField,
  fields: readonly PydanticField[],
): Record<string, ValueEquivalence[]> {
  const serialized: Record<string, ValueEquivalence[]> = {};
  for (const field of fields) {
    const current = currentValueEquivalences(equivalencesByField.get(field.name), field);
    if (current.length > 0) serialized[field.name] = current;
  }
  return serialized;
}

// Quem vê a fila, resolvido pela página (autenticação e impersonação ficam
// lá). `queueUserId` é a identidade efetiva: a do membro impersonado, quando
// há; `ownMemberUserId` é a de quem está logado.
export type CompareQueueIdentity = ReturnType<typeof resolveProjectQueueIdentity> & {
  isCoordinator: boolean;
};

// Toda fonte da fila é estrutural: sem ela, a fila, a cobertura ou as
// contagens saem erradas sem aviso (documento sumido, veredito tido como
// pendente, badge zerado). Falha de qualquer uma vira a tela de erro, com o
// código que liga a tela à linha do log, e não uma fila parcial.
const queueReadError = serverErrorScope("compare-queue");
const QUEUE_ERROR_COPY = "Erro ao carregar a fila de comparação. Tente novamente.";

function firstReadError(
  reads: Record<string, { error: { message: string } | null }>,
): { ok: false; error: string } | null {
  for (const [table, { error }] of Object.entries(reads)) {
    if (error) return { ok: false, error: queueReadError(`leitura de ${table}`, error, QUEUE_ERROR_COPY) };
  }
  return null;
}

export async function loadCompareQueue(
  supabase: Pick<SupabaseServerClient, "from">,
  projectId: string,
  // Promise para que a resolução de acesso corra em paralelo com as buscas
  // que não dependem dela. Se a página a rejeitar (identidade indisponível),
  // o carregador rejeita junto. Ela precisa entrar no primeiro Promise.all,
  // sem `await` antes: senão a rejeição fica um tempo sem handler e a
  // checagem de acesso passa a correr depois das buscas.
  identity: Promise<CompareQueueIdentity>,
  searchParams: Record<string, string | undefined>,
) {
  // Leituras do projeto inteiro paginadas com ordem total pela PK, e as
  // restritas à fila em lotes de documentos: o PostgREST corta cada leitura
  // em 1000 linhas sem erro, e uma lista longa de ids no `.in` estoura a URL
  // (ver fetch-all-paged.ts).
  const [
    projectRead,
    responsesRead,
    supersededRead,
    versionLogRead,
    assignmentsRead,
    equivalencesRead,
    { ownMemberUserId, queueUserId, isImpersonating, isCoordinator },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "pydantic_hash, pydantic_fields, min_responses_for_comparison, schema_version_major, schema_version_minor, schema_version_patch, automation_mode",
      )
      .eq("id", projectId)
      .single(),
    fetchAllAfterId<RawResponseRow>(
      () =>
        supabase
          .from("responses")
          // `documents!inner` + filtro excluded_at: documentos arquivados não
          // entram na fila de comparação (consistente com a contagem de B4).
          .select(
            "id, document_id, respondent_type, respondent_name, respondent_id, answers, justifications, is_latest, is_partial, pydantic_hash, answer_field_hashes, schema_version_major, schema_version_minor, schema_version_patch, created_at, documents!inner(id, title, external_id)",
          )
          .eq("project_id", projectId)
          .eq("is_latest", true)
          .is("documents.excluded_at", null)
          .is("documents.exclusion_pending_at", null),
    ),
    // As respostas substituídas (`is_latest = false`) nunca qualificam
    // (`responseQualifiesForVersion`), mas `respondentNames` e
    // `availableVersions` cobrem o histórico todo: delas vêm só essas colunas,
    // sem `answers` nem `justifications`, que cada nova rodada do LLM empilha.
    // Mesmo recorte de documentos da leitura acima.
    fetchAllAfterId<ResponseLabelRow>(
      () =>
        supabase
          .from("responses")
          .select(
            "id, respondent_name, schema_version_major, schema_version_minor, schema_version_patch, documents!inner(id)",
          )
          .eq("project_id", projectId)
          .eq("is_latest", false)
          .is("documents.excluded_at", null)
          .is("documents.exclusion_pending_at", null),
    ),
    // As versões são ordenadas depois; a PK é a ordem total do cursor.
    fetchAllAfterId<VersionLogRow>(
      () =>
        supabase
          .from("schema_change_log")
          .select("id, version_major, version_minor, version_patch")
          .eq("project_id", projectId)
          .not("version_major", "is", null),
    ),
    fetchAllAfterId<AssignmentRow>(
      () =>
        supabase
          .from("assignments")
          .select("id, document_id, user_id, type, status")
          .eq("project_id", projectId),
    ),
    // Equivalências de valor: escopo do projeto, uma linha por par de valores
    // (centenas por projeto), então não há o que recortar por documento.
    fetchProjectValueEquivalences(supabase, projectId),
    identity,
  ]);

  const readError = firstReadError({
    projects: projectRead,
    responses: responsesRead,
    "responses substituídas": supersededRead,
    schema_change_log: versionLogRead,
    assignments: assignmentsRead,
    value_equivalences: equivalencesRead,
  });
  if (readError) return readError;
  const project = projectRead.data;
  const currentResponses = responsesRead.data;
  // Atuais e substituídas juntas, na ordem da PK de uma leitura só: é a ordem
  // dos nomes no filtro de respondente. O uuid vem em hexa minúsculo, e como
  // texto ordena igual ao `ORDER BY id` do Postgres.
  const responseLabels = [...currentResponses, ...supersededRead.data].toSorted((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const versionLog = versionLogRead.data;
  const allAssignments = assignmentsRead.data;
  const allEquivalences = equivalencesRead.data;

  // fieldName -> equivalências de valor do projeto. Serve à divergência no
  // servidor e à fusão dos cards no cliente.
  const equivalencesByField = groupValueEquivalencesByField(allEquivalences);

  // Fail-CLOSED (ao contrario de comments/llm-insights): showAllQueue decide
  // quais documentos aparecem na fila — quem não pediu "todos" ve so os
  // atribuidos a si (compareAssignedDocIds). A policy RLS deixa qualquer
  // membro ler todas as responses, entao esse recorte e so aplicacional;
  // fail-open exporia documentos/respostas de terceiros em erro transitorio.
  //
  // Coordenador também compara documentos (não só supervisiona) — por isso o
  // padrão é a fila pessoal dele, igual pesquisador. "Todos" é uma escolha
  // explícita via aba/param `queue=all`, só alcançável por coordenador (um
  // não-coordenador nunca chega a showAllQueue=true, mesmo editando a URL).
  // resolveShowAllQueue é testada isoladamente (ver compare-filters.test.ts) —
  // é a mesma classe de expressão que já causou o bug original da página.
  const showAllQueue = resolveShowAllQueue(isCoordinator, searchParams.queue);

  const fields = (project?.pydantic_fields || []) as PydanticField[];

  // Defaults da fila derivados do modo de automação do projeto. Em compare_llm
  // o piso de humanos cai para 1 (a 2ª resposta exigida por minTotal é o LLM) —
  // sem isso a aba ficaria vazia para documentos de 1 codificador + LLM. A
  // revisora ainda pode estreitar a lente via o filtro `min_humans` na URL.
  const compareDefaults = compareDefaultsForMode(
    project?.automation_mode,
    project?.min_responses_for_comparison ?? 2,
  );
  const filters = readCompareFilters(searchParams, compareDefaults);

  // Contexto de versão do helper compartilhado (compare-version.ts) — a MESMA
  // fonte e fallback {0,1,0} do fecho (compare-sync.ts) e do gatilho
  // (auto-comparison.ts). A fila resolve seu `minVersion` a partir da URL
  // (`filters.version`, que pode ser uma lente manual), não da constante.
  const { version: projectVersion, ctx: projectVersionCtx } =
    deriveProjectVersionContext(project ?? {});
  const minVersion = resolveMinVersion(filters.version, projectVersion);
  const sinceMs = filters.since ? new Date(filters.since).getTime() : null;

  // Compare-type assignments filter (ver assignedCompareDocIds).
  const compareAssignedDocIds = assignedCompareDocIds(
    showAllQueue,
    allAssignments,
    queueUserId,
  );

  // Status per user-doc for compare assignment (used in list and panel)
  const compareAssignmentStatusByDoc = buildCompareAssignmentStatusByDoc(
    allAssignments,
    showAllQueue,
    queueUserId,
  );

  const { responsesByDoc, docsMetaMap } = indexResponsesByDoc(currentResponses);

  const { qualifiedDocIds, divergentFields, responsesMap, coverageByDoc: qualifiedCoverageByDoc } =
    qualifyDocumentsForCompare(responsesByDoc, docsMetaMap, {
      compareAssignedDocIds,
      codingAssignedByDoc: buildCodingAssignedByDoc(allAssignments),
      compareAssignmentStatusByDoc,
      filters,
      minVersion,
      projectVersionCtx,
      sinceMs,
      fields,
      equivalencesByField,
    });

  // Fetch text + reviews + comment counts. Texto só dos documentos da fila,
  // em lotes: nada qualificado, nenhuma leitura.
  const [textsRead, reviewsRead, commentsRead, suggestionsRead] = await Promise.all([
    fetchByDocumentChunks(qualifiedDocIds, (ids) =>
      fetchAllAfterId<{ id: string; text: string }>(
        () =>
          supabase
            .from("documents")
            .select("id, text")
            .in("id", ids)
            .is("excluded_at", null)
            .is("exclusion_pending_at", null),
      ),
    ),
    // Só os reviews da identidade efetiva: a revisão é por revisor e este
    // fetch alimenta exclusivamente existingReviews/reviewedCount (ver
    // buildReviewsAndReviewedCounts). Vereditos de terceiros contaminavam o
    // estado "já revisado" da tela e travavam o fecho do parecer.
    fetchAllAfterId<ReviewRow>(
      () =>
        supabase
          .from("reviews")
          .select("id, document_id, field_name, verdict, chosen_response_id, comment, reviewer_id, field_hash")
          .eq("project_id", projectId)
          .eq("reviewer_id", queueUserId),
    ),
    fetchByDocumentChunks(qualifiedDocIds, (ids) =>
      fetchAllAfterId<CommentCountRow>(
        () =>
          supabase
            .from("project_comments")
            .select("id, document_id, field_name")
            .eq("project_id", projectId)
            .in("document_id", ids)
            .is("resolved_at", null),
      ),
    ),
    fetchAllAfterId<SuggestionCountRow>(
      () =>
        supabase
          .from("schema_suggestions")
          .select("id, field_name")
          .eq("project_id", projectId)
          .eq("status", "pending"),
    ),
  ]);

  const secondReadError = firstReadError({
    documents: textsRead,
    reviews: reviewsRead,
    project_comments: commentsRead,
    schema_suggestions: suggestionsRead,
  });
  if (secondReadError) return secondReadError;
  const reviews = reviewsRead.data;
  const commentCounts = commentsRead.data;
  const suggestionCounts = suggestionsRead.data;

  const textMap = new Map(textsRead.data.map((d) => [d.id, d.text]));

  // Reviews da identidade efetiva — na impersonação, o progresso exibido é o
  // do dono da fila, não o do master.
  const { existingReviews, staleReviews, coverageByDoc } = buildReviewsAndReviewedCounts(
    reviews,
    queueUserId,
    qualifiedCoverageByDoc,
    divergentFields,
    new Map(fields.map((f) => [f.name, f])),
  );

  const { commentCountsByKey, suggestionCountsByField } = buildCountsByKey(
    commentCounts,
    suggestionCounts,
    new Set(qualifiedDocIds),
  );

  return {
    ok: true as const,
    props: {
      documents: sortDocumentsByPendingDivergence(
        buildDocumentsForCompare(qualifiedDocIds, textMap, docsMetaMap),
        coverageByDoc,
      ),
      responses: responsesMap,
      divergentFields,
      fields,
      existingReviews,
      staleReviews,
      projectPydanticHash: project?.pydantic_hash ?? null,
      respondentNames: extractRespondentNames(responseLabels),
      defaultMinHumans: compareDefaults.minHumans,
      defaultVersion: compareDefaults.version,
      coverageByDoc: coverageByDoc,
      commentCountsByKey,
      suggestionCountsByField,
      availableVersions: buildAvailableVersions(versionLog, responseLabels),
      latestMajorLabel: formatVersion(latestMajorAnchor(projectVersion)),
      currentProjectVersion: formatVersion(projectVersion),
      // Maps don't cross the RSC boundary.
      equivalencesByField: serializeEquivalencesForClient(equivalencesByField, fields),
      currentUserId: ownMemberUserId,
      canManageAnyPair: isCoordinator,
      isCoordinator,
      queueContext: {
        showingAll: showAllQueue,
        // Distingue "sem nada atribuído" de "tem atribuído, mas foi filtrado
        // por cobertura/divergência" — usado só pela mensagem de estado vazio
        // em ComparePage (trocar de aba não resolve o segundo caso). Só é
        // não-null quando showAllQueue=false (aba "Meus"), que é justamente
        // quando a mensagem é exibida.
        hasAssignedDocs: (compareAssignedDocIds?.size ?? 0) > 0,
        isImpersonating,
      },
    },
  };
}
