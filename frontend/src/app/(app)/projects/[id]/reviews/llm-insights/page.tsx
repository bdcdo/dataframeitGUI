import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { normalizeForComparison } from "@/lib/utils";
import { LlmInsightsView } from "@/components/stats/LlmInsightsView";
import { formatAnswer } from "@/lib/reviews/queries";
import { canonicalPair } from "@/lib/equivalence";
import type { PydanticField } from "@/lib/types";

export interface LlmError {
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  llmAnswer: string;
  llmJustification: string | null;
  chosenVerdict: string;
  reviewerComment: string | null;
  resolvedAt: string | null;
  reviewedAt: string;
  schemaVersion: string | null;
  llmResponseId: string;
  chosenResponseId: string | null;
}

// Every reviewed (doc, field) pair the LLM also answered, after applying the
// same hidden/equivalent/same-content suppressions used to build `errors`.
// Used client-side as the denominator so the error rate respects active filters.
export interface ReviewedEntry {
  documentId: string;
  documentTitle: string;
  fieldName: string;
  schemaVersion: string | null;
  reviewedAt: string;
  isError: boolean;
}

export default async function LlmInsightsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getAuthUser();
  const supabase = await createSupabaseServer();

  const [
    { data: project },
    { data: llmResponses },
    { data: reviews },
    { data: documents },
    { data: errorResolutions },
    { data: equivalencePairs },
    { data: membership },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields, created_by")
      .eq("id", id)
      .single(),
    supabase
      .from("responses")
      .select(
        "id, document_id, answers, justifications, respondent_name, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .eq("project_id", id)
      .eq("respondent_type", "llm")
      .eq("is_current", true),
    supabase
      .from("reviews")
      .select(
        "document_id, field_name, verdict, chosen_response_id, comment, created_at",
      )
      .eq("project_id", id)
      .not("chosen_response_id", "is", null),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .eq("project_id", id),
    supabase
      .from("error_resolutions")
      .select("document_id, field_name, resolved_at")
      .eq("project_id", id),
    supabase
      .from("response_equivalences")
      .select("document_id, field_name, response_a_id, response_b_id")
      .eq("project_id", id),
    user
      ? supabase
          .from("project_members")
          .select("role")
          .eq("project_id", id)
          .eq("user_id", user.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const isCoordinator =
    project?.created_by === user?.id || membership?.role === "coordenador";

  const allFields = (project?.pydantic_fields || []) as PydanticField[];

  const fieldMap = new Map(allFields.map((f) => [f.name, f]));
  const fieldDescMap = new Map(allFields.map((f) => [f.name, f.description]));
  const docMap = new Map(
    documents?.map((d) => [d.id, d.title || d.external_id || d.id]) || [],
  );

  // Build LLM response map: document_id -> response
  const llmByDoc = new Map<
    string,
    {
      id: string;
      answers: Record<string, unknown>;
      justifications: Record<string, string> | null;
      respondent_name: string | null;
      schemaVersion: string | null;
    }
  >();
  llmResponses?.forEach((r) => {
    const v =
      r.schema_version_major != null && r.schema_version_minor != null && r.schema_version_patch != null
        ? `${r.schema_version_major}.${r.schema_version_minor}.${r.schema_version_patch}`
        : null;
    llmByDoc.set(r.document_id, {
      id: r.id,
      answers: r.answers as Record<string, unknown>,
      justifications: r.justifications as Record<string, string> | null,
      respondent_name: r.respondent_name,
      schemaVersion: v,
    });
  });

  // Build error resolution map: "docId:fieldName" -> resolved_at
  const errorResolvedMap = new Map(
    errorResolutions?.map((r) => [
      `${r.document_id}:${r.field_name}`,
      r.resolved_at,
    ]) || [],
  );

  // Build equivalence pair set: "docId:fieldName:a|b" (canonical) for direct lookup
  const equivPairSet = new Set<string>();
  equivalencePairs?.forEach((p) => {
    const [a, b] = canonicalPair(p.response_a_id, p.response_b_id);
    equivPairSet.add(`${p.document_id}:${p.field_name}:${a}|${b}`);
  });

  // Compute LLM errors and the parallel list of every reviewed (doc, field)
  // entry that survived the same suppressions. The client uses
  // `reviewedEntries` as the denominator so the rate matches the filtered card.
  const errors: LlmError[] = [];
  const reviewedEntries: ReviewedEntry[] = [];

  reviews?.forEach((review) => {
    const llmResp = llmByDoc.get(review.document_id);
    if (!llmResp) return;

    const field = fieldMap.get(review.field_name);
    // Skip fields that are hidden from humans (target=none) or LLM-only.
    // These shouldn't show up as "errors" since coordenador chose to remove
    // them from the review surface — past reviews would otherwise leak.
    if (!field || field.target === "none" || field.target === "llm_only") return;

    let isError = false;
    if (review.chosen_response_id !== llmResp.id) {
      const llmAnswer = llmResp.answers?.[review.field_name];
      const sameContent =
        normalizeForComparison(llmAnswer) ===
        normalizeForComparison(review.verdict);

      let markedEquivalent = false;
      if (review.chosen_response_id) {
        const [a, b] = canonicalPair(llmResp.id, review.chosen_response_id);
        markedEquivalent = equivPairSet.has(
          `${review.document_id}:${review.field_name}:${a}|${b}`,
        );
      }

      if (!sameContent && !markedEquivalent) {
        isError = true;
        errors.push({
          documentId: review.document_id,
          documentTitle: docMap.get(review.document_id) || review.document_id,
          fieldName: review.field_name,
          fieldDescription:
            fieldDescMap.get(review.field_name) || review.field_name,
          llmAnswer: formatAnswer(llmAnswer),
          llmJustification:
            llmResp.justifications?.[review.field_name] || null,
          chosenVerdict: review.verdict,
          reviewerComment: review.comment,
          resolvedAt:
            errorResolvedMap.get(
              `${review.document_id}:${review.field_name}`,
            ) || null,
          reviewedAt: review.created_at,
          schemaVersion: llmResp.schemaVersion,
          llmResponseId: llmResp.id,
          chosenResponseId: review.chosen_response_id,
        });
      }
    }

    reviewedEntries.push({
      documentId: review.document_id,
      documentTitle: docMap.get(review.document_id) || review.document_id,
      fieldName: review.field_name,
      schemaVersion: llmResp.schemaVersion,
      reviewedAt: review.created_at,
      isError,
    });
  });

  const totalLlmDocs = llmByDoc.size;

  const reviewedDocIds = new Set(reviews?.map((r) => r.document_id) || []);
  const unreviewedLlmDocs = [...llmByDoc.keys()].filter((id) => !reviewedDocIds.has(id)).length;

  // Visible fields for the dropdown filter (same criteria as the error suppression).
  const visibleFields = allFields.filter(
    (f) => f.target !== "llm_only" && f.target !== "none",
  );

  return (
    <div className="mx-auto max-w-4xl p-6">
      <LlmInsightsView
        projectId={id}
        errors={errors}
        reviewedEntries={reviewedEntries}
        fields={visibleFields}
        allFields={allFields}
        isCoordinator={isCoordinator}
        summary={{ totalLlmDocs, unreviewedLlmDocs }}
      />
    </div>
  );
}
