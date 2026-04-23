import { createSupabaseServer } from "@/lib/supabase/server";
import {
  getLlmResponsesForProject,
  getLlmRuns,
} from "@/actions/llm";
import { LlmResponsesPane } from "@/components/llm/LlmResponsesPane";
import type { PydanticField } from "@/lib/types";

export default async function LlmResponsesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ job?: string }>;
}) {
  const { id } = await params;
  const { job } = await searchParams;

  const supabase = await createSupabaseServer();

  const [{ data: project }, responses, runs] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", id)
      .single(),
    getLlmResponsesForProject(id, { jobId: job, limit: 500 }),
    getLlmRuns(id, 50),
  ]);

  const fieldLabels: Record<string, string> = {};
  const fields = (project?.pydantic_fields as PydanticField[] | null) ?? [];
  for (const f of fields) {
    if (f?.name && f?.description) fieldLabels[f.name] = f.description;
  }

  return (
    <LlmResponsesPane
      projectId={id}
      responses={responses}
      runs={runs}
      fieldLabels={fieldLabels}
      activeJobId={job ?? null}
    />
  );
}
