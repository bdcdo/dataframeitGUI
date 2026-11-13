import { createSupabaseServer } from "@/lib/supabase/server";
import { usesAutoReviewSource } from "@/lib/llm-error-metrics";
import { AutoReviewVerdictsExportCard } from "./AutoReviewVerdictsExportCard";

// O card dos vereditos da auto-revisão só existe em projetos
// 'auto_review_llm'. RSC à parte para a leitura do modo correr em paralelo com
// as da página, sem pesar no componente dela.
export async function AutoReviewVerdictsExport({ projectId }: { projectId: string }) {
  const supabase = await createSupabaseServer();
  const { data: project } = await supabase
    .from("projects")
    .select("automation_mode")
    .eq("id", projectId)
    .single();
  if (!usesAutoReviewSource(project?.automation_mode ?? null)) return null;
  return <AutoReviewVerdictsExportCard projectId={projectId} />;
}
