import { createSupabaseServer } from "@/lib/supabase/server";
import { LlmTab } from "@/components/llm/LlmTab";
import { getLlmRuns } from "@/actions/llm";
import type { PydanticField } from "@/lib/types";

export default async function LlmConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const [{ data: project }, { count: totalDocs }, { data: llmResponses }, runs] =
    await Promise.all([
      supabase
        .from("projects")
        .select(
          "prompt_template, description, llm_provider, llm_model, llm_kwargs, pydantic_fields, pydantic_code"
        )
        .eq("id", id)
        .single(),
      supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("project_id", id),
      supabase
        .from("responses")
        .select("document_id")
        .eq("project_id", id)
        .eq("respondent_type", "llm")
        .eq("is_current", true),
      getLlmRuns(id),
    ]);

  const docsWithLlm = new Set(llmResponses?.map((r) => r.document_id)).size;

  return (
    <LlmTab
      projectId={id}
      promptTemplate={project?.prompt_template ?? ""}
      projectDescription={project?.description ?? ""}
      config={{
        llm_provider: project?.llm_provider || "google_genai",
        llm_model: project?.llm_model || "gemini-3-flash-preview",
        llm_kwargs:
          (project?.llm_kwargs as Record<string, unknown>) || {
            temperature: 1.0,
            thinking_level: "medium",
          },
      }}
      pydanticFields={(project?.pydantic_fields as PydanticField[]) || null}
      pydanticCode={(project?.pydantic_code as string | null) ?? null}
      totalDocs={totalDocs ?? 0}
      docsWithLlm={docsWithLlm}
      runs={runs}
    />
  );
}
