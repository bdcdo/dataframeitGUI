import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  fetchReviewBaseData,
  computeRespondentProfiles,
} from "@/lib/reviews/queries";
import { RespondentProfile } from "@/components/reviews/RespondentProfile";
import { DateSinceFilter } from "@/components/reviews/DateSinceFilter";

export default async function RespondentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ since?: string }>;
}) {
  const { id } = await params;
  const { since } = await searchParams;
  const user = await getAuthUser();
  if (!user) redirect("/auth/login");

  const supabase = await createSupabaseServer();

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

  const ctx = await fetchReviewBaseData(supabase, id, { since });
  const respondentProfiles = computeRespondentProfiles(ctx);

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-4">
      <DateSinceFilter />
      {respondentProfiles.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {since
            ? "Nenhum respondente com respostas no período selecionado."
            : "Nenhum perfil de respondente disponível. Revise documentos na aba Comparar para gerar dados."}
        </p>
      ) : (
        <RespondentProfile
          respondentProfiles={respondentProfiles}
          fields={ctx.comparableFields}
        />
      )}
    </div>
  );
}
