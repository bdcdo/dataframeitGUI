import { createSupabaseServer } from "@/lib/supabase/server";
import {
  getDefaultAutomationMode,
  type AutomationMode,
} from "@/lib/automation-modes";
import { isLlmEnabled } from "@/lib/feature-flags";
import { RulesForm } from "./RulesForm";

interface ProjectRulesRow {
  resolution_rule?: string | null;
  min_responses_for_comparison?: number | null;
  allow_researcher_review?: boolean | null;
  automation_mode?: AutomationMode | null;
  comparison_includes_llm?: boolean | null;
  out_of_scope_enabled?: boolean | null;
}

function valueOrDefault<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

function normalizeRules(
  project: ProjectRulesRow | null,
  llmEnabled: boolean,
) {
  const row: ProjectRulesRow = project ?? {};
  return {
    resolutionRule: valueOrDefault(row.resolution_rule, "majority"),
    minResponses: valueOrDefault(row.min_responses_for_comparison, 2),
    allowResearcherReview: valueOrDefault(
      row.allow_researcher_review,
      false,
    ),
    automationMode: valueOrDefault(
      row.automation_mode,
      getDefaultAutomationMode(llmEnabled),
    ),
    comparisonIncludesLlm: valueOrDefault(
      row.comparison_includes_llm,
      llmEnabled,
    ),
    outOfScopeEnabled: valueOrDefault(row.out_of_scope_enabled, true),
  };
}

export default async function RulesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, supabase] = await Promise.all([params, createSupabaseServer()]);
  const llmEnabled = isLlmEnabled();

  const { data: project } = await supabase
    .from("projects")
    .select("resolution_rule, min_responses_for_comparison, allow_researcher_review, automation_mode, comparison_includes_llm, out_of_scope_enabled")
    .eq("id", id)
    .single();
  const formProps = normalizeRules(project, llmEnabled);

  return (
    <div className="mx-auto max-w-2xl p-6">
      <RulesForm projectId={id} {...formProps} />
    </div>
  );
}
