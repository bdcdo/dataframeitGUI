import { createSupabaseServer } from "@/lib/supabase/server";
import { normalizeForComparison } from "@/lib/utils";
import { ReviewsView } from "@/components/stats/ReviewsView";
import type { PydanticField } from "@/lib/types";

/* ── Tipos internos para dados pré-computados ── */

export interface RespondentAnswer {
  respondentKey: string;
  respondentName: string;
  respondentType: "humano" | "llm";
  answer: unknown;
  justification: string | null;
  isCorrect: boolean;
  isStale: boolean;
}

export interface ReviewedField {
  fieldName: string;
  fieldDescription: string;
  fieldType: "single" | "multi" | "text";
  verdict: string;
  respondentAnswers: RespondentAnswer[];
}

export interface ReviewedDocument {
  documentId: string;
  documentTitle: string;
  fields: ReviewedField[];
}

export interface ConfusionDataSingle {
  type: "single";
  fieldName: string;
  fieldDescription: string;
  options: string[];
  matrix: Record<string, Record<string, number>>;
  total: number;
}

export interface ConfusionDataMulti {
  type: "multi";
  fieldName: string;
  fieldDescription: string;
  options: { option: string; correct: number; total: number; accuracy: number }[];
}

export interface ConfusionDataText {
  type: "text";
  fieldName: string;
  fieldDescription: string;
  concordanceRate: number;
  concordant: number;
  total: number;
}

export type ConfusionData = ConfusionDataSingle | ConfusionDataMulti | ConfusionDataText;

export interface RespondentProfileData {
  respondentKey: string;
  respondentName: string;
  respondentType: "humano" | "llm";
  overallCorrect: number;
  overallTotal: number;
  overallAccuracy: number;
  perField: Record<string, { correct: number; total: number; accuracy: number }>;
  mostErroredFields: { fieldName: string; fieldDescription: string; errorRate: number }[];
}

export interface HardestDocumentData {
  documentId: string;
  documentTitle: string;
  totalFieldsReviewed: number;
  totalErrors: number;
  errorRate: number;
}

/* ── Helpers ── */

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

function isAnswerCorrect(
  answer: unknown,
  verdict: string,
  fieldType: "single" | "multi" | "text",
): boolean {
  if (verdict === "ambiguo" || verdict === "pular") return true; // não é erro
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

function formatAnswer(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val.join(", ");
  return String(val);
}

/* ── Page ── */

export default async function ReviewsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  // Fase 1: queries paralelas
  const [
    { data: project },
    { data: responses },
    { data: reviews },
    { data: documents },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields, pydantic_hash")
      .eq("id", id)
      .single(),
    supabase
      .from("responses")
      .select(
        "id, document_id, respondent_id, respondent_type, respondent_name, answers, justifications, is_current, pydantic_hash, answer_field_hashes",
      )
      .eq("project_id", id)
      .eq("is_current", true),
    supabase
      .from("reviews")
      .select(
        "id, document_id, field_name, verdict, chosen_response_id, comment, reviewer_id",
      )
      .eq("project_id", id),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .eq("project_id", id),
  ]);

  const fields = (project?.pydantic_fields || []) as PydanticField[];
  const projectPydanticHash = project?.pydantic_hash || null;

  // Mapas auxiliares
  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  const docMap = new Map(
    documents?.map((d) => [d.id, d.title || d.external_id || d.id]) || [],
  );
  const currentFieldHashes: Record<string, string> = {};
  for (const f of fields) {
    if (f.hash) currentFieldHashes[f.name] = f.hash;
  }

  // Fase 2: buscar nomes de respondentes
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

  // Agrupar responses por document_id
  const responsesByDoc = new Map<
    string,
    {
      id: string;
      respondent_id: string | null;
      respondent_type: "humano" | "llm";
      respondent_name: string | null;
      answers: Record<string, unknown>;
      justifications: Record<string, string> | null;
      pydantic_hash: string | null;
      answer_field_hashes: Record<string, string> | null;
    }[]
  >();
  responses?.forEach((r) => {
    const list = responsesByDoc.get(r.document_id) || [];
    list.push({
      id: r.id,
      respondent_id: r.respondent_id,
      respondent_type: r.respondent_type as "humano" | "llm",
      respondent_name: r.respondent_name,
      answers: r.answers as Record<string, unknown>,
      justifications: r.justifications as Record<string, string> | null,
      pydantic_hash: r.pydantic_hash,
      answer_field_hashes: r.answer_field_hashes as Record<string, string> | null,
    });
    responsesByDoc.set(r.document_id, list);
  });

  // Deduplica reviews por (document_id, field_name) — pega o mais recente
  const reviewMap = new Map<string, (typeof reviews extends (infer T)[] | null ? T : never)>();
  reviews
    ?.sort((a, b) => b.id.localeCompare(a.id))
    .forEach((r) => {
      const key = `${r.document_id}:${r.field_name}`;
      if (!reviewMap.has(key)) reviewMap.set(key, r);
    });

  const uniqueReviews = [...reviewMap.values()];

  // Campos comparáveis (exclui llm_only e human_only)
  const comparableFields = fields.filter(
    (f) => !f.target || f.target === "all",
  );

  // Helper para respondent key
  function getRespondentKey(r: { respondent_id: string | null; respondent_name: string | null; respondent_type: string }) {
    return r.respondent_type === "humano" ? (r.respondent_id || "unknown") : (r.respondent_name || "llm");
  }
  function getRespondentDisplayName(r: { respondent_id: string | null; respondent_name: string | null; respondent_type: string }) {
    if (r.respondent_type === "humano") {
      return r.respondent_id ? (profileMap.get(r.respondent_id) || r.respondent_name || "Pesquisador") : (r.respondent_name || "Pesquisador");
    }
    return r.respondent_name || "LLM";
  }

  /* ─── 1. Reviewed Documents ─── */

  const reviewsByDoc = new Map<string, typeof uniqueReviews>();
  uniqueReviews.forEach((r) => {
    const list = reviewsByDoc.get(r.document_id) || [];
    list.push(r);
    reviewsByDoc.set(r.document_id, list);
  });

  const reviewedDocuments: ReviewedDocument[] = [];
  for (const [docId, docReviews] of reviewsByDoc) {
    const docResponses = responsesByDoc.get(docId) || [];
    const reviewedFields: ReviewedField[] = [];

    for (const review of docReviews) {
      const field = fieldMap.get(review.field_name);
      if (!field) continue;

      const respondentAnswers: RespondentAnswer[] = docResponses.map((r) => {
        const answer = r.answers[review.field_name];
        const stale = isFieldStale(
          r.answer_field_hashes,
          r.pydantic_hash,
          review.field_name,
          currentFieldHashes,
          projectPydanticHash,
        );
        const correct = isAnswerCorrect(answer, review.verdict, field.type);
        return {
          respondentKey: getRespondentKey(r),
          respondentName: getRespondentDisplayName(r),
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
      reviewedDocuments.push({
        documentId: docId,
        documentTitle: docMap.get(docId) || docId,
        fields: reviewedFields,
      });
    }
  }

  // Ordenar por título
  reviewedDocuments.sort((a, b) => a.documentTitle.localeCompare(b.documentTitle));

  /* ─── 2. Confusion Data ─── */

  const confusionDataList: ConfusionData[] = [];

  for (const field of comparableFields) {
    const fieldReviews = uniqueReviews.filter(
      (r) => r.field_name === field.name && r.verdict !== "ambiguo" && r.verdict !== "pular",
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
          if (!matrix[correctAnswer]) {
            allLabels.push(correctAnswer);
            matrix[correctAnswer] = {};
            for (const opt of allLabels) matrix[correctAnswer][opt] = 0;
            for (const opt of allLabels) {
              if (!matrix[opt][correctAnswer]) matrix[opt][correctAnswer] = 0;
            }
          }
        }
        const docResps = responsesByDoc.get(review.document_id) || [];
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
      confusionDataList.push({
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
          const docResps = responsesByDoc.get(review.document_id) || [];
          for (const resp of docResps) {
            const arr = resp.answers[field.name];
            const actualSelected = Array.isArray(arr) && arr.includes(option);
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
      confusionDataList.push({
        type: "multi",
        fieldName: field.name,
        fieldDescription: field.description,
        options: optionStats,
      });
    } else if (field.type === "text") {
      let concordant = 0;
      let total = 0;
      for (const review of fieldReviews) {
        const docResps = responsesByDoc.get(review.document_id) || [];
        for (const resp of docResps) {
          const answer = resp.answers[field.name];
          total++;
          if (normalizeForComparison(answer) === normalizeForComparison(review.verdict)) {
            concordant++;
          }
        }
      }
      confusionDataList.push({
        type: "text",
        fieldName: field.name,
        fieldDescription: field.description,
        concordanceRate: total > 0 ? Math.round((concordant / total) * 100) : 0,
        concordant,
        total,
      });
    }
  }

  /* ─── 3. Respondent Profiles ─── */

  // Collect unique respondents from responses
  const respondentMap = new Map<string, { name: string; type: "humano" | "llm" }>();
  responses?.forEach((r) => {
    const key = getRespondentKey(r as { respondent_id: string | null; respondent_name: string | null; respondent_type: string });
    if (!respondentMap.has(key)) {
      respondentMap.set(key, {
        name: getRespondentDisplayName(r as { respondent_id: string | null; respondent_name: string | null; respondent_type: string }),
        type: r.respondent_type as "humano" | "llm",
      });
    }
  });

  const respondentProfiles: RespondentProfileData[] = [];
  for (const [respondentKey, info] of respondentMap) {
    let overallCorrect = 0;
    let overallTotal = 0;
    const perField: Record<string, { correct: number; total: number; accuracy: number }> = {};

    for (const review of uniqueReviews) {
      if (review.verdict === "ambiguo" || review.verdict === "pular") continue;
      const field = fieldMap.get(review.field_name);
      if (!field) continue;
      // Respeitar target
      if (field.target === "llm_only" && info.type === "humano") continue;
      if (field.target === "human_only" && info.type === "llm") continue;

      const docResps = responsesByDoc.get(review.document_id) || [];
      const resp = docResps.find(
        (r) => getRespondentKey(r as { respondent_id: string | null; respondent_name: string | null; respondent_type: string }) === respondentKey,
      );
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

    // Calcular acurácia por campo
    for (const fn of Object.keys(perField)) {
      const pf = perField[fn];
      pf.accuracy = pf.total > 0 ? Math.round((pf.correct / pf.total) * 100) : 0;
    }

    // Top campos com mais erros
    const mostErroredFields = Object.entries(perField)
      .filter(([, v]) => v.total > 0 && v.accuracy < 100)
      .map(([fn, v]) => ({
        fieldName: fn,
        fieldDescription: fieldMap.get(fn)?.description || fn,
        errorRate: 100 - v.accuracy,
      }))
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, 3);

    if (overallTotal > 0) {
      respondentProfiles.push({
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

  // Ordenar por acurácia
  respondentProfiles.sort((a, b) => a.overallAccuracy - b.overallAccuracy);

  /* ─── 4. Hardest Documents ─── */

  const hardestDocuments: HardestDocumentData[] = [];
  for (const [docId, docReviews] of reviewsByDoc) {
    const docResps = responsesByDoc.get(docId) || [];
    if (docResps.length === 0) continue;

    let totalFieldsReviewed = 0;
    let totalErrors = 0;

    for (const review of docReviews) {
      if (review.verdict === "ambiguo" || review.verdict === "pular") continue;
      const field = fieldMap.get(review.field_name);
      if (!field) continue;

      for (const resp of docResps) {
        // Respeitar target
        if (field.target === "llm_only" && resp.respondent_type === "humano") continue;
        if (field.target === "human_only" && resp.respondent_type === "llm") continue;

        const answer = resp.answers[review.field_name];
        const correct = isAnswerCorrect(answer, review.verdict, field.type);
        totalFieldsReviewed++;
        if (!correct) totalErrors++;
      }
    }

    if (totalFieldsReviewed > 0) {
      hardestDocuments.push({
        documentId: docId,
        documentTitle: docMap.get(docId) || docId,
        totalFieldsReviewed,
        totalErrors,
        errorRate: Math.round((totalErrors / totalFieldsReviewed) * 100),
      });
    }
  }

  hardestDocuments.sort((a, b) => b.errorRate - a.errorRate);

  /* ─── Render ─── */

  return (
    <div className="mx-auto max-w-5xl p-6">
      <ReviewsView
        projectId={id}
        reviewedDocuments={reviewedDocuments}
        confusionDataList={confusionDataList}
        respondentProfiles={respondentProfiles}
        hardestDocuments={hardestDocuments}
        fields={comparableFields}
      />
    </div>
  );
}
