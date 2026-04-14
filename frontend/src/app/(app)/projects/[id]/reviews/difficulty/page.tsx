import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  fetchReviewBaseData,
  computeHardestDocuments,
} from "@/lib/reviews/queries";
import { HardestDocuments } from "@/components/reviews/HardestDocuments";
import { DateSinceFilter } from "@/components/reviews/DateSinceFilter";

export default async function DifficultyPage({
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
  const hardestDocuments = computeHardestDocuments(ctx);

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-4">
      <DateSinceFilter />
      {hardestDocuments.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {since
            ? "Nenhum documento com dificuldade no período selecionado."
            : "Nenhum dado de dificuldade disponível. Revise documentos na aba Comparar para gerar dados."}
        </p>
      ) : (
        <HardestDocuments hardestDocuments={hardestDocuments} projectId={id} />
      )}
    </div>
  );
}
