import { createSupabaseServer } from "@/lib/supabase/server";
import { StatsOverview } from "@/components/stats/StatsOverview";
import { FieldProgress } from "@/components/stats/FieldProgress";
import { VerdictChart } from "@/components/stats/VerdictChart";

export default async function StatsOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const [
    { data: project },
    { count: totalAssignments },
    { count: completedAssignments },
    { data: reviews },
    { data: questionMeta },
    { data: responses },
    { data: llmResponses },
    { data: difficultyResolutions },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", id)
      .single(),
    supabase
      .from("assignments")
      .select("id", { count: "exact", head: true })
      .eq("project_id", id),
    supabase
      .from("assignments")
      .select("id", { count: "exact", head: true })
      .eq("project_id", id)
      .eq("status", "concluido"),
    supabase
      .from("reviews")
      .select("document_id, field_name, verdict, comment, chosen_response_id, resolved_at")
      .eq("project_id", id),
    supabase
      .from("question_meta")
      .select("field_name, priority")
      .eq("project_id", id),
    supabase
      .from("responses")
      .select("id, document_id, respondent_type, answers")
      .eq("project_id", id)
      .eq("is_current", true),
    supabase
      .from("responses")
      .select("id, document_id")
      .eq("project_id", id)
      .eq("respondent_type", "llm")
      .eq("is_current", true),
    supabase
      .from("difficulty_resolutions")
      .select("response_id")
      .eq("project_id", id),
  ]);

  const fields = (project?.pydantic_fields || []) as {
    name: string;
    description: string;
    target?: string;
  }[];

  const comparableFields = fields.filter((f) => f.target !== "llm_only");

  const priorityMap = new Map(
    questionMeta?.map((q) => [q.field_name, q.priority]) || [],
  );

  // --- Agreement calculation ---
  let totalComparisons = 0;
  let agreements = 0;
  type ResponseRow = { id: string; document_id: string; respondent_type: string; answers: unknown };
  const responsesByDoc = new Map<string, ResponseRow[]>();
  responses?.forEach((r) => {
    if (!responsesByDoc.has(r.document_id))
      responsesByDoc.set(r.document_id, []);
    responsesByDoc.get(r.document_id)!.push(r);
  });

  for (const [, docResponses] of responsesByDoc) {
    if (docResponses.length < 2) continue;
    for (const field of comparableFields) {
      totalComparisons++;
      const answers = docResponses.map((r) =>
        JSON.stringify((r.answers as Record<string, unknown>)?.[field.name]),
      );
      if (new Set(answers).size === 1) agreements++;
    }
  }

  const agreement =
    totalComparisons > 0
      ? Math.round((agreements / totalComparisons) * 100)
      : 0;

  // --- Open comments count ---
  const openComments =
    reviews?.filter((r) => r.comment && !r.resolved_at).length || 0;

  // --- LLM difficulties count ---
  const resolvedResponseIds = new Set(
    difficultyResolutions?.map((d) => d.response_id) || [],
  );
  const llmWithDifficulties =
    responses?.filter(
      (r) =>
        r.respondent_type === "llm" &&
        (r.answers as Record<string, unknown>)?.llm_ambiguidades &&
        !resolvedResponseIds.has(r.id),
    ) || [];
  const openDifficulties = llmWithDifficulties.length;

  // --- LLM error rate ---
  const llmByDoc = new Map<string, string>();
  llmResponses?.forEach((r) => {
    llmByDoc.set(r.document_id, r.id);
  });

  let llmFieldsReviewed = 0;
  let llmErrors = 0;
  const errorsByField = new Map<string, { errors: number; total: number }>();

  reviews?.forEach((review) => {
    if (!review.chosen_response_id) return;
    const llmId = llmByDoc.get(review.document_id);
    if (!llmId) return;
    llmFieldsReviewed++;
    if (review.chosen_response_id !== llmId) {
      llmErrors++;
      const entry = errorsByField.get(review.field_name) || {
        errors: 0,
        total: 0,
      };
      entry.errors++;
      entry.total++;
      errorsByField.set(review.field_name, entry);
    } else {
      const entry = errorsByField.get(review.field_name) || {
        errors: 0,
        total: 0,
      };
      entry.total++;
      errorsByField.set(review.field_name, entry);
    }
  });

  const llmErrorRate =
    llmFieldsReviewed > 0
      ? Math.round((llmErrors / llmFieldsReviewed) * 100)
      : 0;

  const topErrorFields = [...errorsByField.entries()]
    .map(([name, { errors, total }]) => ({
      name,
      description:
        fields.find((f) => f.name === name)?.description || name,
      rate: total > 0 ? Math.round((errors / total) * 100) : 0,
      errors,
      total,
    }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 3);

  const hasLlm = (llmResponses?.length || 0) > 0;

  // --- Field progress & chart ---
  const reviewsByField = new Map<
    string,
    { agreed: number; divergent: number; reviewed: number }
  >();
  reviews?.forEach((r) => {
    if (!reviewsByField.has(r.field_name)) {
      reviewsByField.set(r.field_name, {
        agreed: 0,
        divergent: 0,
        reviewed: 0,
      });
    }
    reviewsByField.get(r.field_name)!.reviewed++;
  });

  const chartData = comparableFields.slice(0, 20).map((f) => ({
    field: f.name.replace(/^q\d+_\d+_/, "").slice(0, 15),
    ...(reviewsByField.get(f.name) || { agreed: 0, divergent: 0, reviewed: 0 }),
  }));

  const docsWithMultipleResponses = [...responsesByDoc.entries()].filter(
    ([, rs]) => rs.length >= 2,
  ).length;

  const fieldProgressData = comparableFields.map((f) => {
    const reviewed = reviewsByField.get(f.name)?.reviewed || 0;
    const progress =
      docsWithMultipleResponses > 0
        ? Math.round((reviewed / docsWithMultipleResponses) * 100)
        : 0;
    return {
      name: f.name,
      description: f.description,
      progress: Math.min(progress, 100),
      priority:
        (priorityMap.get(f.name) as "ALTA" | "MEDIA" | "BAIXA") || "MEDIA",
    };
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <StatsOverview
        coded={completedAssignments || 0}
        totalCoding={totalAssignments || 0}
        agreement={agreement}
        reviews={reviews?.length || 0}
        totalReviews={
          comparableFields.length * docsWithMultipleResponses
        }
        openComments={openComments}
        openDifficulties={openDifficulties}
        hasLlm={hasLlm}
        llmErrorRate={llmErrorRate}
        topErrorFields={topErrorFields}
      />
      <div>
        <h3 className="mb-3 text-lg font-semibold">Progresso por Campo</h3>
        <FieldProgress fields={fieldProgressData} />
      </div>
      <div>
        <h3 className="mb-3 text-lg font-semibold">Vereditos por Campo</h3>
        <VerdictChart data={chartData} />
      </div>
    </div>
  );
}
