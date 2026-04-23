import { getLlmRunStats, getLlmRuns } from "@/actions/llm";
import { LlmRunsPane, type LlmRunStats } from "@/components/llm/LlmRunsPane";

export default async function LlmRunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const runs = await getLlmRuns(id, 50);

  const statsEntries = await Promise.all(
    runs.map(async (r) => [r.job_id, await getLlmRunStats(r.job_id)] as const)
  );
  const stats: Record<string, LlmRunStats> = Object.fromEntries(statsEntries);

  return <LlmRunsPane projectId={id} runs={runs} stats={stats} />;
}
