import { createSupabaseServer } from "@/lib/supabase/server";
import { RulesForm } from "./RulesForm";

export default async function RulesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, supabase] = await Promise.all([params, createSupabaseServer()]);

  const { data: project } = await supabase
    .from("projects")
    .select("resolution_rule, min_responses_for_comparison, allow_researcher_review, automation_mode, comparison_includes_llm")
    .eq("id", id)
    .single();

  return (
    <div className="mx-auto max-w-2xl p-6">
      <RulesForm
        projectId={id}
        resolutionRule={project?.resolution_rule || "majority"}
        minResponses={project?.min_responses_for_comparison || 2}
        allowResearcherReview={project?.allow_researcher_review ?? false}
        automationMode={project?.automation_mode ?? "auto_review_llm"}
        comparisonIncludesLlm={project?.comparison_includes_llm ?? true}
      />
    </div>
  );
}
