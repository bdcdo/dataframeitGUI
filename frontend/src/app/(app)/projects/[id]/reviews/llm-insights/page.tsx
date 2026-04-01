import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { normalizeForComparison } from "@/lib/utils";
import { LlmInsightsView } from "@/components/stats/LlmInsightsView";
import { formatAnswer } from "@/lib/reviews/queries";
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
}

export interface LlmDifficulty {
  responseId: string;
  documentId: string;
  documentTitle: string;
  modelName: string;
  text: string;
  resolvedAt: string | null;
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
    { data: difficultyResolutions },
    { data: errorResolutions },
    { data: membership },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields, created_by")
      .eq("id", id)
      .single(),
    supabase
      .from("responses")
      .select("id, document_id, answers, justifications, respondent_name")
      .eq("project_id", id)
      .eq("respondent_type", "llm")
      .eq("is_current", true),
    supabase
      .from("reviews")
      .select(
        "document_id, field_name, verdict, chosen_response_id, comment",
      )
      .eq("project_id", id)
      .not("chosen_response_id", "is", null),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .eq("project_id", id),
    supabase
      .from("difficulty_resolutions")
      .select("response_id, resolved_at")
      .eq("project_id", id),
    supabase
      .from("error_resolutions")
      .select("document_id, field_name, resolved_at")
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

  const fields = (project?.pydantic_fields || []) as {
    name: string;
    description: string;
    target?: string;
  }[];

  const fieldDescMap = new Map(fields.map((f) => [f.name, f.description]));
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
    }
  >();
  llmResponses?.forEach((r) => {
    llmByDoc.set(r.document_id, {
      id: r.id,
      answers: r.answers as Record<string, unknown>,
      justifications: r.justifications as Record<string, string> | null,
      respondent_name: r.respondent_name,
    });
  });

  // Build error resolution map: "docId:fieldName" -> resolved_at
  const errorResolvedMap = new Map(
    errorResolutions?.map((r) => [
      `${r.document_id}:${r.field_name}`,
      r.resolved_at,
    ]) || [],
  );

  // Compute LLM errors
  const errors: LlmError[] = [];
  let llmFieldsReviewed = 0;

  reviews?.forEach((review) => {
    const llmResp = llmByDoc.get(review.document_id);
    if (!llmResp) return;
    llmFieldsReviewed++;
    if (review.chosen_response_id !== llmResp.id) {
      const llmAnswer = llmResp.answers?.[review.field_name];
      // Skip if the LLM answer matches the chosen verdict (same content, different responder)
      if (
        normalizeForComparison(llmAnswer) ===
        normalizeForComparison(review.verdict)
      )
        return;
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
      });
    }
  });

  const totalLlmDocs = llmByDoc.size;
  const totalErrors = errors.length;
  const errorRate =
    llmFieldsReviewed > 0
      ? Math.round((totalErrors / llmFieldsReviewed) * 100)
      : 0;

  // Build difficulties list
  const resolvedMap = new Map(
    difficultyResolutions?.map((d) => [d.response_id, d.resolved_at]) || [],
  );

  const difficulties: LlmDifficulty[] = [];
  llmResponses?.forEach((r) => {
    const ambiguidades = (r.answers as Record<string, unknown>)
      ?.llm_ambiguidades;
    if (
      !ambiguidades ||
      (typeof ambiguidades === "string" && !ambiguidades.trim())
    )
      return;
    difficulties.push({
      responseId: r.id,
      documentId: r.document_id,
      documentTitle: docMap.get(r.document_id) || r.document_id,
      modelName: r.respondent_name || "LLM",
      text: String(ambiguidades),
      resolvedAt: resolvedMap.get(r.id) || null,
    });
  });

  return (
    <div className="mx-auto max-w-4xl p-6">
      <LlmInsightsView
        projectId={id}
        errors={errors}
        difficulties={difficulties}
        fields={fields.filter((f) => f.target !== "llm_only")}
        allFields={allFields}
        isCoordinator={isCoordinator}
        summary={{ totalLlmDocs, totalErrors, errorRate }}
      />
    </div>
  );
}
