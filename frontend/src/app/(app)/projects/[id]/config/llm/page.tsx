import { createSupabaseServer } from "@/lib/supabase/server";
import { LlmControl } from "@/components/schema/LlmControl";

export default async function LlmPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const { data: project } = await supabase
    .from("projects")
    .select("llm_provider, llm_model, llm_kwargs")
    .eq("id", id)
    .single();

  return (
    <LlmControl
      projectId={id}
      config={{
        llm_provider: project?.llm_provider || "google_genai",
        llm_model: project?.llm_model || "gemini-3-flash-preview",
        llm_kwargs: (project?.llm_kwargs as Record<string, unknown>) || { temperature: 1.0, thinking_level: "medium" },
      }}
    />
  );
}
