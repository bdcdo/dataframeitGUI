import { createSupabaseServer } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import {
  fetchReviewBaseData,
  computeRespondentProfiles,
} from "@/lib/reviews/queries";
import { RespondentProfile } from "@/components/reviews/RespondentProfile";

export default async function RespondentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // Check coordinator access
  const [{ data: project }, { data: membership }] = await Promise.all([
    supabase
      .from("projects")
      .select("created_by")
      .eq("id", id)
      .single(),
    supabase
      .from("project_members")
      .select("role")
      .eq("project_id", id)
      .eq("user_id", user.id)
      .single(),
  ]);

  const isCoordinator =
    membership?.role === "coordenador" || project?.created_by === user.id;

  if (!isCoordinator) {
    redirect(`/projects/${id}/reviews/gabarito`);
  }

  const ctx = await fetchReviewBaseData(supabase, id);
  const respondentProfiles = computeRespondentProfiles(ctx);

  if (respondentProfiles.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nenhum perfil de respondente disponível. Revise documentos na aba
        Comparar para gerar dados.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-4">
      <RespondentProfile
        respondentProfiles={respondentProfiles}
        fields={ctx.comparableFields}
      />
    </div>
  );
}
