import { createSupabaseServer } from "@/lib/supabase/server";
import { GeneralForm } from "./GeneralForm";

export default async function GeneralConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const { data: project } = await supabase
    .from("projects")
    .select("name, description")
    .eq("id", id)
    .single();

  return (
    <GeneralForm
      projectId={id}
      name={project?.name ?? ""}
      description={project?.description ?? ""}
    />
  );
}
