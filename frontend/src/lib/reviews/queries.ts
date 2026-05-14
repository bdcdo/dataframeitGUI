import { normalizeForComparison } from "@/lib/utils";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PydanticField } from "@/lib/types";
import type {
  ReviewedDocument,
  ReviewedField,
  RespondentAnswer,
  ConfusionData,
  RespondentProfileData,
  HardestDocumentData,
} from "./types";

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
  answer_field_hashes: Record<string, string> | null;
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
  currentFieldHashes: Record<string, string>;
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

function isFieldStale(
  answerFieldHashes: Record<string, string> | null,
  pydanticHash: string | null,
  fieldName: string,
  currentFieldHashes: Record<string, string>,
  projectPydanticHash: string | null,
): boolean {
  if (answerFieldHashes) {
    const saved = answerFieldHashes[fieldName];
    const current = currentFieldHashes[fieldName];
    return !saved || !current || saved !== current;
  }
  return !!projectPydanticHash && pydanticHash !== projectPydanticHash;
}

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
        Object.entries(verdictMap)
          .filter(([, v]) => v)
          .map(([k]) => k),
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
      .map((v) => formatAnswer(v))
      .filter((s) => s !== "")
      .join(", ");
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const parts = Object.entries(obj)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${formatAnswer(v)}`);
    return parts.join("; ");
  }
  return String(val);
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
      "id, document_id, respondent_id, respondent_type, respondent_name, answers, justifications, is_current, pydantic_hash, answer_field_hashes, created_at",
    )
    .eq("project_id", projectId)
    .eq("is_current", true)
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

  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  const docMap = new Map(
    documents?.map((d) => [d.id, d.title || d.external_id || d.id]) || [],
  );
  const currentFieldHashes: Record<string, string> = {};
  for (const f of fields) {
    if (f.hash) currentFieldHashes[f.name] = f.hash;
  }

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
      answer_field_hashes: r.answer_field_hashes as Record<
        string,
        string
      > | null,
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
        const stale = isFieldStale(
          r.answer_field_hashes,
          r.pydantic_hash,
          review.field_name,
          ctx.currentFieldHashes,
          ctx.projectPydanticHash,
        );
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

/* ── Computation: Confusion Data ── */

export function computeConfusionData(
  ctx: ReviewComputationContext,
): ConfusionData[] {
  const result: ConfusionData[] = [];

  for (const field of ctx.comparableFields) {
    if (field.type === "text" || field.type === "date") continue;

    const fieldReviews = ctx.uniqueReviews.filter(
      (r) =>
        r.field_name === field.name &&
        r.verdict !== "ambiguo" &&
        r.verdict !== "pular",
    );
    if (fieldReviews.length === 0) continue;

    if (field.type === "single" && field.options) {
      const matrix: Record<string, Record<string, number>> = {};
      const allLabels = [...field.options];
      for (const opt of allLabels) {
        matrix[opt] = {};
        for (const opt2 of allLabels) matrix[opt][opt2] = 0;
      }
      let total = 0;
      for (const review of fieldReviews) {
        const correctAnswer = review.verdict;
        if (!allLabels.includes(correctAnswer)) {
          allLabels.push(correctAnswer);
          matrix[correctAnswer] = {};
          for (const opt of allLabels) matrix[correctAnswer][opt] = 0;
          for (const opt of allLabels) {
            if (!matrix[opt][correctAnswer]) matrix[opt][correctAnswer] = 0;
          }
        }
        const docResps = ctx.responsesByDoc.get(review.document_id) || [];
        for (const resp of docResps) {
          const given = formatAnswer(resp.answers[field.name]);
          if (!given) continue;
          if (!matrix[given]) {
            allLabels.push(given);
            matrix[given] = {};
            for (const opt of allLabels) matrix[given][opt] = 0;
            for (const opt of allLabels) {
              if (!matrix[opt][given]) matrix[opt][given] = 0;
            }
          }
          matrix[given][correctAnswer]++;
          total++;
        }
      }
      result.push({
        type: "single",
        fieldName: field.name,
        fieldDescription: field.description,
        options: allLabels,
        matrix,
        total,
      });
    } else if (field.type === "multi" && field.options) {
      const optionStats = field.options.map((option) => {
        let correct = 0;
        let total = 0;
        for (const review of fieldReviews) {
          let verdictMap: Record<string, boolean>;
          try {
            verdictMap = JSON.parse(review.verdict) as Record<string, boolean>;
          } catch {
            continue;
          }
          const expectedSelected = verdictMap[option] ?? false;
          const docResps = ctx.responsesByDoc.get(review.document_id) || [];
          for (const resp of docResps) {
            const arr = resp.answers[field.name];
            const actualSelected =
              Array.isArray(arr) && arr.includes(option);
            total++;
            if (actualSelected === expectedSelected) correct++;
          }
        }
        return {
          option,
          correct,
          total,
          accuracy: total > 0 ? Math.round((correct / total) * 100) : 0,
        };
      });
      result.push({
        type: "multi",
        fieldName: field.name,
        fieldDescription: field.description,
        options: optionStats,
      });
    }
  }

  return result;
}

/* ── Computation: Respondent Profiles ── */

export function computeRespondentProfiles(
  ctx: ReviewComputationContext,
): RespondentProfileData[] {
  const respondentInfoMap = new Map<
    string,
    { name: string; type: "humano" | "llm" }
  >();

  for (const [, docResps] of ctx.responsesByDoc) {
    for (const r of docResps) {
      const key = getRespondentKey(r);
      if (!respondentInfoMap.has(key)) {
        respondentInfoMap.set(key, {
          name: getRespondentDisplayName(r, ctx.profileMap),
          type: r.respondent_type,
        });
      }
    }
  }

  const result: RespondentProfileData[] = [];

  for (const [respondentKey, info] of respondentInfoMap) {
    let overallCorrect = 0;
    let overallTotal = 0;
    const perField: Record<
      string,
      { correct: number; total: number; accuracy: number }
    > = {};

    for (const review of ctx.uniqueReviews) {
      if (review.verdict === "ambiguo" || review.verdict === "pular") continue;
      const field = ctx.fieldMap.get(review.field_name);
      if (!field) continue;
      if (field.target === "none") continue;
      if (field.target === "llm_only" && info.type === "humano") continue;
      if (field.target === "human_only" && info.type === "llm") continue;

      const docResps = ctx.responsesByDoc.get(review.document_id) || [];
      const resp = docResps.find((r) => getRespondentKey(r) === respondentKey);
      if (!resp) continue;

      const answer = resp.answers[review.field_name];
      const correct = isAnswerCorrect(answer, review.verdict, field.type);

      overallTotal++;
      if (correct) overallCorrect++;

      if (!perField[review.field_name]) {
        perField[review.field_name] = { correct: 0, total: 0, accuracy: 0 };
      }
      perField[review.field_name].total++;
      if (correct) perField[review.field_name].correct++;
    }

    for (const fn of Object.keys(perField)) {
      const pf = perField[fn];
      pf.accuracy =
        pf.total > 0 ? Math.round((pf.correct / pf.total) * 100) : 0;
    }

    const mostErroredFields = Object.entries(perField)
      .filter(([, v]) => v.total > 0 && v.accuracy < 100)
      .map(([fn, v]) => ({
        fieldName: fn,
        fieldDescription: ctx.fieldMap.get(fn)?.description || fn,
        errorRate: 100 - v.accuracy,
      }))
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, 3);

    if (overallTotal > 0) {
      result.push({
        respondentKey,
        respondentName: info.name,
        respondentType: info.type,
        overallCorrect,
        overallTotal,
        overallAccuracy: Math.round((overallCorrect / overallTotal) * 100),
        perField,
        mostErroredFields,
      });
    }
  }

  result.sort((a, b) => a.overallAccuracy - b.overallAccuracy);
  return result;
}

/* ── Computation: Hardest Documents ── */

export function computeHardestDocuments(
  ctx: ReviewComputationContext,
): HardestDocumentData[] {
  const reviewsByDoc = new Map<string, ReviewRow[]>();
  ctx.uniqueReviews.forEach((r) => {
    const list = reviewsByDoc.get(r.document_id) || [];
    list.push(r);
    reviewsByDoc.set(r.document_id, list);
  });

  const result: HardestDocumentData[] = [];

  for (const [docId, docReviews] of reviewsByDoc) {
    const docResps = ctx.responsesByDoc.get(docId) || [];
    if (docResps.length === 0) continue;

    let totalFieldsReviewed = 0;
    let totalErrors = 0;

    for (const review of docReviews) {
      if (review.verdict === "ambiguo" || review.verdict === "pular") continue;
      const field = ctx.fieldMap.get(review.field_name);
      if (!field) continue;
      if (field.target === "none") continue;

      for (const resp of docResps) {
        if (field.target === "llm_only" && resp.respondent_type === "humano")
          continue;
        if (field.target === "human_only" && resp.respondent_type === "llm")
          continue;

        const answer = resp.answers[review.field_name];
        const correct = isAnswerCorrect(answer, review.verdict, field.type);
        totalFieldsReviewed++;
        if (!correct) totalErrors++;
      }
    }

    if (totalFieldsReviewed > 0) {
      result.push({
        documentId: docId,
        documentTitle: ctx.docMap.get(docId) || docId,
        totalFieldsReviewed,
        totalErrors,
        errorRate: Math.round((totalErrors / totalFieldsReviewed) * 100),
      });
    }
  }

  result.sort((a, b) => b.errorRate - a.errorRate);
  return result;
}
