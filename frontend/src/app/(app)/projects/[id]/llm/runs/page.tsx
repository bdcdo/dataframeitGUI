import { getLlmRunStats, getLlmRuns } from "@/actions/llm";
import { createSupabaseServer } from "@/lib/supabase/server";
import { LlmRunsPane, type LlmRunStats } from "@/components/llm/LlmRunsPane";

export default async function LlmRunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, supabase] = await Promise.all([params, createSupabaseServer()]);
  const [runs, { data: rounds, error: roundsError }] = await Promise.all([
    getLlmRuns(id, 50),
    supabase.from("rounds").select("id, label").eq("project_id", id),
  ]);
  if (roundsError) throw new Error(roundsError.message);

  const statsEntries = await Promise.all(
    runs.map(async (r) => [r.job_id, await getLlmRunStats(r.job_id)] as const)
  );
  const stats: Record<string, LlmRunStats> = Object.fromEntries(statsEntries);

  return (
    <LlmRunsPane
      projectId={id}
      runs={runs}
      stats={stats}
      rounds={rounds ?? []}
    />
  );
}
