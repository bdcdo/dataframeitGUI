// Funções puras que montam a fila de comparação (analyze/compare/page.tsx).
//
// Extraído do Server Component `ComparePageRoute` (issue #388, epic #376):
// ele não usa hooks React (é async, sem useState/useEffect), então a extração
// de complexidade cabível ali é para funções puras em src/lib/ — o mesmo
// padrão já usado por compare-filters.ts, compare-divergence.ts e
// compare-version.ts (extraídos deste mesmo arquivo em refactors anteriores).
// A página fica responsável só por buscar dados no Supabase, chamar estas
// funções em sequência e montar as props de <ComparePage>.

import type { EquivalenceByDocField, EquivalencePairRow } from "@/lib/compare-divergence";
import { comparisonSet, type ComparisonSet } from "@/lib/comparison-set";
import type { CompareFiltersValue } from "@/lib/compare-filters";
import {
  type ProjectVersionContext,
  type SchemaVersion,
  parseVersionStr,
} from "@/lib/compare-version";
import type { ReviewsByDoc } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import type { CompareResponse } from "@/components/compare/compare-types";

export interface CompareDoc {
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
export interface CompareQueueResponse extends CompareResponse {
  document_id: string;
}

export interface DocCoverage {
  docId: string;
  humanCount: number; // responderam com versão ok
  totalCount: number;
  assignedCodingCount: number; // pesquisadores atribuídos em codificação
  humansFromAssigned: number; // dos atribuídos, quantos responderam
  divergentCount: number;
  reviewedCount: number;
  assignmentStatus: "pendente" | "em_andamento" | "concluido" | null;
}

// Row solta o suficiente para aceitar o resultado do select do Supabase (que
// também traz o join `documents`, cujo tipo inferido não bate 1:1 com
// Omit<CompareDoc, "text">) sem replicar seu tipo inferido — mesma pragmática
// de `as unknown as CompareQueueResponse` que o page.tsx já usava. Sem index
// signature de propósito: bastam os campos abaixo (structural typing ignora
// os demais campos da row real/de teste), e um index signature exigiria o
// mesmo em qualquer valor passado (inclusive em fixtures de teste tipadas
// como CompareQueueResponse).
interface RawResponseRow {
  document_id: string;
  respondent_name: string | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
  documents?: unknown;
}

export interface VersionLogRow {
  version_major: number | null;
  version_minor: number | null;
  version_patch: number | null;
}

// Local de propósito: é a row de SELECT que `compare/page.tsx` passa
// posicionalmente (checagem estrutural, sem importar o nome), não um tipo de
// domínio. Exportá-lo colidia com o `AssignmentRow` homônimo de
// `auto-review-backlog.ts`, que é um payload de INSERT com outro shape
// (tem project_id; type/status são literais lá, string solto aqui).
interface AssignmentRow {
  document_id: string;
  user_id: string;
  type: string;
  status: string;
}

export interface ReviewRow {
  document_id: string;
  field_name: string;
  verdict: string;
  chosen_response_id: string | null;
  comment: string | null;
  reviewer_id: string | null;
}

export interface CommentCountRow {
  document_id: string | null;
  field_name: string | null;
}

export interface SuggestionCountRow {
  field_name: string;
}

export function indexResponsesByDoc(allResponses: readonly RawResponseRow[] | null): {
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
export function extractRespondentNames(allResponses: readonly RawResponseRow[] | null): string[] {
  return [
    ...new Set(
      allResponses?.flatMap((r) => (r.respondent_name ? [r.respondent_name] : [])) ?? [],
    ),
  ];
}

// Build distinct ordered version list desc — une versões do schema_change_log
// com as efetivamente gravadas em responses (cobre respostas cuja versão veio
// do backfill por hashes/created_at e não tem entry classificada no log).
export function buildAvailableVersions(
  versionLog: readonly VersionLogRow[] | null,
  allResponses: readonly RawResponseRow[] | null,
): string[] {
  const versionSet = new Set<string>();
  for (const v of versionLog ?? []) {
    if (v.version_major !== null && v.version_minor !== null && v.version_patch !== null) {
      versionSet.add(`${v.version_major}.${v.version_minor}.${v.version_patch}`);
    }
  }
  for (const r of allResponses ?? []) {
    if (
      r.schema_version_major !== null &&
      r.schema_version_minor !== null &&
      r.schema_version_patch !== null
    ) {
      versionSet.add(
        `${r.schema_version_major}.${r.schema_version_minor}.${r.schema_version_patch}`,
      );
    }
  }
  return Array.from(versionSet).toSorted((a, b) => {
    const pa = parseVersionStr(a)!;
    const pb = parseVersionStr(b)!;
    if (pa.major !== pb.major) return pb.major - pa.major;
    if (pa.minor !== pb.minor) return pb.minor - pa.minor;
    return pb.patch - pa.patch;
  });
}

// Coding-type assignments map per doc (denominator for % atribuídos)
export function buildCodingAssignedByDoc(
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
export function buildCompareAssignmentStatusByDoc(
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

export interface QualifyDocumentsContext {
  compareAssignedDocIds: Set<string> | null;
  codingAssignedByDoc: Map<string, Set<string>>;
  compareAssignmentStatusByDoc: Map<string, "pendente" | "em_andamento" | "concluido">;
  filters: CompareFiltersValue;
  minVersion: SchemaVersion | null;
  projectVersionCtx: ProjectVersionContext;
  sinceMs: number | null;
  fields: PydanticField[];
  equivByDocField: EquivalenceByDocField;
}

export interface QualifiedDocumentsResult {
  qualifiedDocIds: string[];
  divergentFields: Record<string, string[]>;
  responsesMap: Record<string, CompareQueueResponse[]>;
  coverageByDoc: Record<string, DocCoverage>;
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
  coverage: DocCoverage;
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
    equivalencesByField: ctx.equivByDocField.get(docId),
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
      reviewedCount: 0, // preenchido depois, por buildReviewsAndReviewedCounts
      assignmentStatus: ctx.compareAssignmentStatusByDoc.get(docId) ?? null,
    },
  };
}

export function qualifyDocumentsForCompare(
  responsesByDoc: Map<string, CompareQueueResponse[]>,
  docsMetaMap: Map<string, Omit<CompareDoc, "text">>,
  ctx: QualifyDocumentsContext,
): QualifiedDocumentsResult {
  const qualifiedDocIds: string[] = [];
  const divergentFields: Record<string, string[]> = {};
  const responsesMap: Record<string, CompareQueueResponse[]> = {};
  const coverageByDoc: Record<string, DocCoverage> = {};

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
export function buildDocumentsForCompare(
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

export function buildReviewsAndReviewedCounts(
  reviews: readonly ReviewRow[] | null,
  userId: string,
  qualifiedDocIds: string[],
  divergentFields: Record<string, string[]>,
): { existingReviews: ReviewsByDoc; reviewedCountByDoc: Record<string, number> } {
  const existingReviews: ReviewsByDoc = {};

  // A revisão da Comparação é POR REVISOR (UNIQUE inclui reviewer_id, e
  // syncCompareAssignment fecha o assignment contando só os reviews do
  // usuário). Por isso `existingReviews` — que semeia `localReviews` e decide
  // "campo/doc já revisado" na UI — considera SÓ a identidade efetiva, igual
  // ao reviewedCount. Semear com vereditos de terceiros (comportamento antigo)
  // marcava docs revisados por outro revisor como "Revisão concluída" na tela
  // de quem nunca os revisou: o teclado de voto era bloqueado e o assignment
  // nunca fechava — o parecer travava na fila (bug relatado em 2026-07-10).
  const myReviewsByDoc = new Map<string, Set<string>>();
  reviews?.forEach((r) => {
    if (r.reviewer_id !== userId) return;
    if (!existingReviews[r.document_id]) existingReviews[r.document_id] = {};
    existingReviews[r.document_id][r.field_name] = {
      verdict: r.verdict,
      chosenResponseId: r.chosen_response_id ?? null,
      comment: r.comment ?? null,
    };
    if (!myReviewsByDoc.has(r.document_id)) myReviewsByDoc.set(r.document_id, new Set());
    myReviewsByDoc.get(r.document_id)!.add(r.field_name);
  });

  const reviewedCountByDoc: Record<string, number> = {};
  for (const docId of qualifiedDocIds) {
    const reviewed = myReviewsByDoc.get(docId) ?? new Set<string>();
    const divergent = divergentFields[docId] ?? [];
    reviewedCountByDoc[docId] = divergent.filter((fn) => reviewed.has(fn)).length;
  }

  return { existingReviews, reviewedCountByDoc };
}

// Build comment+suggestion counts by (doc, field)
export function buildCountsByKey(
  commentCounts: readonly CommentCountRow[] | null,
  suggestionCounts: readonly SuggestionCountRow[] | null,
): {
  commentCountsByKey: Record<string, number>;
  suggestionCountsByField: Record<string, number>;
} {
  const commentCountsByKey: Record<string, number> = {};
  for (const c of commentCounts ?? []) {
    const key = `${c.document_id ?? ""}|${c.field_name ?? ""}`;
    commentCountsByKey[key] = (commentCountsByKey[key] ?? 0) + 1;
  }
  const suggestionCountsByField: Record<string, number> = {};
  for (const s of suggestionCounts ?? []) {
    suggestionCountsByField[s.field_name] = (suggestionCountsByField[s.field_name] ?? 0) + 1;
  }
  return { commentCountsByKey, suggestionCountsByField };
}

// Sort docs: most unreviewed divergences first. `.toSorted` para não mutar o
// array recebido (o caller ainda pode precisar da ordem original).
export function sortDocumentsByPendingDivergence(
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
// boundary). Only ship pairs for documents in the qualified list.
export function serializeEquivalencesForClient(
  equivByDocField: EquivalenceByDocField,
  qualifiedDocIds: string[],
): Record<string, Record<string, EquivalencePairRow[]>> {
  const equivalencesByDocField: Record<string, Record<string, EquivalencePairRow[]>> = {};
  for (const docId of qualifiedDocIds) {
    const fieldMap = equivByDocField.get(docId);
    if (!fieldMap) continue;
    equivalencesByDocField[docId] = {};
    for (const [fieldName, pairs] of fieldMap) {
      equivalencesByDocField[docId][fieldName] = pairs;
    }
  }
  return equivalencesByDocField;
}
