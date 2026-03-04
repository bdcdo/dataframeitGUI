import { createSupabaseServer } from "@/lib/supabase/server";
import { RulesForm } from "./RulesForm";

export default async function RulesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const { data: project } = await supabase
    .from("projects")
    .select("resolution_rule, min_responses_for_comparison, allow_researcher_review")
    .eq("id", id)
    .single();

  return (
    <div className="mx-auto max-w-2xl p-6">
      <RulesForm
        projectId={id}
        resolutionRule={project?.resolution_rule || "majority"}
        minResponses={project?.min_responses_for_comparison || 2}
        allowResearcherReview={project?.allow_researcher_review ?? false}
      />
    </div>
  );
}
