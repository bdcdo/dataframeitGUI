import { normalizeForComparison } from "@/lib/utils";
import { buildFieldHashMap, isFieldStale } from "@/lib/answer-staleness";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import type {
  ReviewedDocument,
  ReviewedField,
  RespondentAnswer,
} from "./types";
import { buildReviewLookupMaps } from "./lookup-maps";

/* ── Raw row shapes ── */

interface ResponseRow {
  id: string;
  document_id: string;
  respondent_id: string | null;
  respondent_type: "humano" | "llm";
  respondent_name: string | null;
  answers: Record<string, unknown>;
  justifications: Record<string, string> | null;
  pydantic_hash: string | null;
  answer_field_hashes: AnswerFieldHashes;
  created_at: string;
}

interface ReviewRow {
  id: string;
  document_id: string;
  field_name: string;
  verdict: string;
  chosen_response_id: string | null;
  comment: string | null;
  reviewer_id: string | null;
}

/* ── Context shared across computations ── */

export interface ReviewDataTruncation {
  responses: boolean;
  reviews: boolean;
  documents: boolean;
}

export interface ReviewComputationContext {
  fields: PydanticField[];
  comparableFields: PydanticField[];
  projectPydanticHash: string | null;
  currentFieldHashes: Record<string, string | null>;
  fieldMap: Map<string, PydanticField>;
  docMap: Map<string, string>;
  responsesByDoc: Map<string, ResponseRow[]>;
  uniqueReviews: ReviewRow[];
  profileMap: Map<string, string>;
  // true para cada tabela cuja query atingiu REVIEW_BASE_DATA_LIMIT — os
  // dados agregados podem estar silenciosamente errados. As paginas de
  // reviews renderizam um TruncationBanner quando alguma flag e true.
  truncated: ReviewDataTruncation;
}

/* ── Pure helpers ── */

export function isAnswerCorrect(
  answer: unknown,
  verdict: string,
  fieldType: "single" | "multi" | "text" | "date",
): boolean {
  if (verdict === "ambiguo" || verdict === "pular") return true;
  if (fieldType === "multi") {
    try {
      const verdictMap = JSON.parse(verdict) as Record<string, boolean>;
      const verdictSet = new Set(
        Object.entries(verdictMap).flatMap(([k, v]) => (v ? [k] : [])),
      );
      const answerArr = Array.isArray(answer) ? answer : [];
      const answerSet = new Set(answerArr.map(String));
      if (verdictSet.size !== answerSet.size) return false;
      for (const v of verdictSet) if (!answerSet.has(v)) return false;
      return true;
    } catch {
      return normalizeForComparison(answer) === normalizeForComparison(verdict);
    }
  }
  return normalizeForComparison(answer) === normalizeForComparison(verdict);
}

export function formatAnswer(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) {
    return val
      .flatMap((v) => {
        const s = formatAnswer(v);
        return s !== "" ? [s] : [];
      })
      .join(", ");
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const parts = Object.entries(obj).flatMap(([k, v]) =>
      v != null && v !== "" ? [`${k}: ${formatAnswer(v)}`] : [],
    );
    return parts.join("; ");
  }
  return String(val);
}

// Resolve o respondente cujas respostas a aba "Meu Gabarito" exibe.
// Só coordenador, criador ou master podem inspecionar as respostas de OUTRO
// respondente (via ?viewAsUser=...); qualquer outro vê as do próprio membro
// canônico do projeto.
// SEGURANÇA: a policy RLS "Members view responses" deixa qualquer membro ler
// todas as responses do projeto (não filtra por respondent_id), então esta
// checagem é a única barreira — por isso o `isCoordinator` que a alimenta é
// fail-closed. Ver reviews/my-verdicts/page.tsx.
export function resolveViewedRespondentId(opts: {
  ownMemberUserId: string;
  isCoordinator: boolean;
  viewAsUser: string | undefined;
}): string {
  const { ownMemberUserId, isCoordinator, viewAsUser } = opts;
  return isCoordinator && viewAsUser ? viewAsUser : ownMemberUserId;
}

function getRespondentKey(r: {
  respondent_id: string | null;
  respondent_name: string | null;
  respondent_type: string;
}) {
  return r.respondent_type === "humano"
    ? r.respondent_id || "unknown"
    : r.respondent_name || "llm";
}

function getRespondentDisplayName(
  r: {
    respondent_id: string | null;
    respondent_name: string | null;
    respondent_type: string;
  },
  profileMap: Map<string, string>,
) {
  if (r.respondent_type === "humano") {
    return r.respondent_id
      ? profileMap.get(r.respondent_id) || r.respondent_name || "Pesquisador"
      : r.respondent_name || "Pesquisador";
  }
  return r.respondent_name || "LLM";
}

/* ── Fetch base data ── */

export const REVIEW_BASE_DATA_LIMIT = 50000;

/**
 * Marca como `true` cada tabela cuja query atingiu o teto de
 * REVIEW_BASE_DATA_LIMIT linhas. Query que falhou (`null`) nao conta como
 * truncada — `null?.length` e `undefined`, nunca igual ao teto.
 */
export function computeTruncation(
  responses: unknown[] | null,
  reviews: unknown[] | null,
  documents: unknown[] | null,
): ReviewDataTruncation {
  return {
    responses: responses?.length === REVIEW_BASE_DATA_LIMIT,
    reviews: reviews?.length === REVIEW_BASE_DATA_LIMIT,
    documents: documents?.length === REVIEW_BASE_DATA_LIMIT,
  };
}

export async function fetchReviewBaseData(
  supabase: SupabaseClient,
  projectId: string,
  options?: { since?: string },
): Promise<ReviewComputationContext> {
  let responsesQuery = supabase
    .from("responses")
    .select(
      "id, document_id, respondent_id, respondent_type, respondent_name, answers, justifications, is_latest, pydantic_hash, answer_field_hashes, created_at",
    )
    .eq("project_id", projectId)
    .eq("is_latest", true)
    .limit(REVIEW_BASE_DATA_LIMIT);

  if (options?.since) {
    responsesQuery = responsesQuery.gte("created_at", options.since);
  }

  const [
    { data: project },
    { data: responses },
    { data: reviews },
    { data: documents },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields, pydantic_hash, created_by")
      .eq("id", projectId)
      .single(),
    responsesQuery,
    supabase
      .from("reviews")
      .select(
        "id, document_id, field_name, verdict, chosen_response_id, comment, reviewer_id",
      )
      .eq("project_id", projectId)
      .limit(REVIEW_BASE_DATA_LIMIT),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .eq("project_id", projectId)
      .is("excluded_at", null)
      .is("exclusion_pending_at", null)
      .limit(REVIEW_BASE_DATA_LIMIT),
  ]);

  const truncated = computeTruncation(responses, reviews, documents);
  for (const [name, isTruncated] of Object.entries(truncated)) {
    if (isTruncated) {
      console.warn(
        `fetchReviewBaseData: ${name} atingiu o teto de ${REVIEW_BASE_DATA_LIMIT} linhas para o projeto ${projectId} — dados podem estar truncados, considere paginar.`,
      );
    }
  }

  const fields = (project?.pydantic_fields || []) as PydanticField[];
  const projectPydanticHash = project?.pydantic_hash || null;

  const { fieldMap, docMap } = buildReviewLookupMaps(fields, documents);
  const currentFieldHashes = buildFieldHashMap(fields);

  // Fetch profile names
  const respondentIds = new Set<string>();
  responses?.forEach((r) => {
    if (r.respondent_id) respondentIds.add(r.respondent_id);
  });
  reviews?.forEach((r) => {
    if (r.reviewer_id) respondentIds.add(r.reviewer_id);
  });

  let profileMap = new Map<string, string>();
  if (respondentIds.size > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", [...respondentIds]);
    profileMap = new Map(
      profiles?.map((p) => [p.id, p.full_name || p.id]) || [],
    );
  }

  // Group responses by document_id
  const responsesByDoc = new Map<string, ResponseRow[]>();
  responses?.forEach((r) => {
    const list = responsesByDoc.get(r.document_id) || [];
    list.push({
      id: r.id,
      document_id: r.document_id,
      respondent_id: r.respondent_id,
      respondent_type: r.respondent_type as "humano" | "llm",
      respondent_name: r.respondent_name,
      answers: r.answers as Record<string, unknown>,
      justifications: r.justifications as Record<string, string> | null,
      pydantic_hash: r.pydantic_hash,
      answer_field_hashes: r.answer_field_hashes as AnswerFieldHashes,
      created_at: r.created_at,
    });
    responsesByDoc.set(r.document_id, list);
  });

  // Deduplicate reviews by (document_id, field_name) — latest wins
  const reviewMap = new Map<string, ReviewRow>();
  (reviews as ReviewRow[] | null)
    ?.sort((a, b) => b.id.localeCompare(a.id))
    .forEach((r) => {
      const key = `${r.document_id}:${r.field_name}`;
      if (!reviewMap.has(key)) reviewMap.set(key, r);
    });

  const uniqueReviews = [...reviewMap.values()];

  const comparableFields = fields.filter(
    (f) => !f.target || f.target === "all",
  );

  return {
    fields,
    comparableFields,
    projectPydanticHash,
    currentFieldHashes,
    fieldMap,
    docMap,
    responsesByDoc,
    uniqueReviews,
    profileMap,
    truncated,
  };
}

/* ── Computation: Reviewed Documents ── */

export function computeReviewedDocuments(
  ctx: ReviewComputationContext,
): ReviewedDocument[] {
  const reviewsByDoc = new Map<string, ReviewRow[]>();
  ctx.uniqueReviews.forEach((r) => {
    const list = reviewsByDoc.get(r.document_id) || [];
    list.push(r);
    reviewsByDoc.set(r.document_id, list);
  });

  const result: ReviewedDocument[] = [];

  for (const [docId, docReviews] of reviewsByDoc) {
    const docResponses = ctx.responsesByDoc.get(docId) || [];
    const reviewedFields: ReviewedField[] = [];

    for (const review of docReviews) {
      const field = ctx.fieldMap.get(review.field_name);
      if (!field) continue;

      const respondentAnswers: RespondentAnswer[] = docResponses.map((r) => {
        const answer = r.answers[review.field_name];
        const stale = isFieldStale({
          answerFieldHashes: r.answer_field_hashes,
          pydanticHash: r.pydantic_hash,
          fieldName: review.field_name,
          currentFieldHashes: ctx.currentFieldHashes,
          projectPydanticHash: ctx.projectPydanticHash,
        });
        const correct = isAnswerCorrect(answer, review.verdict, field.type);
        return {
          respondentKey: getRespondentKey(r),
          respondentName: getRespondentDisplayName(r, ctx.profileMap),
          respondentType: r.respondent_type,
          answer,
          justification: r.justifications?.[review.field_name] || null,
          isCorrect: correct,
          isStale: stale,
        };
      });

      reviewedFields.push({
        fieldName: review.field_name,
        fieldDescription: field.description,
        fieldType: field.type,
        verdict: review.verdict,
        respondentAnswers,
      });
    }

    if (reviewedFields.length > 0) {
      result.push({
        documentId: docId,
        documentTitle: ctx.docMap.get(docId) || docId,
        fields: reviewedFields,
      });
    }
  }

  result.sort((a, b) => a.documentTitle.localeCompare(b.documentTitle));
  return result;
}
