import { createSupabaseServer } from "@/lib/supabase/server";
import { PromptEditor } from "@/components/schema/PromptEditor";

export default async function PromptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const { data: project } = await supabase
    .from("projects")
    .select("prompt_template")
    .eq("id", id)
    .single();

  return (
    <PromptEditor projectId={id} initialPrompt={project?.prompt_template} />
  );
}
