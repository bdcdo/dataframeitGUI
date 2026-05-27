import { createSupabaseServer } from "@/lib/supabase/server";
import { GeneralForm } from "./GeneralForm";

export default async function GeneralConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, supabase] = await Promise.all([params, createSupabaseServer()]);

  const { data: project } = await supabase
    .from("projects")
    .select("name, description, arbitration_blind")
    .eq("id", id)
    .single();

  return (
    <GeneralForm
      projectId={id}
      name={project?.name ?? ""}
      description={project?.description ?? ""}
      arbitrationBlind={project?.arbitration_blind ?? true}
    />
  );
}
