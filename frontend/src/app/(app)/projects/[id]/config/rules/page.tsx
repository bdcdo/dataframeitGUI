import { notFound } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { RulesForm } from "./RulesForm";

export default async function RulesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, supabase] = await Promise.all([params, createSupabaseServer()]);

  const { data: project, error } = await supabase
    .from("projects")
    .select("resolution_rule, min_responses_for_comparison, allow_researcher_review, automation_mode, comparison_includes_llm, out_of_scope_enabled")
    .eq("id", id)
    .maybeSingle();

  // Sem leitura confiável, nada de formulário: o RulesForm grava os seis
  // campos juntos, então valores inventados por fallback sobrescreveriam a
  // configuração real no primeiro "Salvar" (o modo de automação inclusive).
  if (error) throw new Error("Não foi possível carregar as regras do projeto.");
  if (!project) notFound();

  return (
    <div className="mx-auto max-w-2xl p-6">
      <RulesForm
        projectId={id}
        resolutionRule={project.resolution_rule || "majority"}
        minResponses={project.min_responses_for_comparison || 2}
        allowResearcherReview={project.allow_researcher_review ?? false}
        automationMode={project.automation_mode}
        comparisonIncludesLlm={project.comparison_includes_llm ?? true}
        outOfScopeEnabled={project.out_of_scope_enabled ?? true}
      />
    </div>
  );
}
