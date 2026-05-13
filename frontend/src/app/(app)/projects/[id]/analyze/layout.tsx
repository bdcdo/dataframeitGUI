import { AnalyzeNav } from "@/components/analyze/AnalyzeNav";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, isProjectCoordinator } from "@/lib/auth";

export default async function AnalyzeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Esconde abas Auto-revisão / Arbitragem para quem nao tem assignments
  // correspondentes (a menos que seja coordenador, que sempre ve).
  const user = await getAuthUser();
  let showAutoReview = false;
  let showArbitragem = false;

  if (user) {
    const supabase = await createSupabaseServer();
    const [{ data: assignmentTypes }, isCoord] = await Promise.all([
      supabase
        .from("assignments")
        .select("type")
        .eq("project_id", id)
        .eq("user_id", user.id)
        .in("type", ["auto_revisao", "arbitragem"])
        .neq("status", "concluido")
        .limit(50),
      isProjectCoordinator(supabase, id, user),
    ]);

    const hasAutoReview = (assignmentTypes ?? []).some(
      (a) => a.type === "auto_revisao",
    );
    const hasArbitragem = (assignmentTypes ?? []).some(
      (a) => a.type === "arbitragem",
    );
    showAutoReview = isCoord || hasAutoReview;
    showArbitragem = isCoord || hasArbitragem;
  }

  return (
    <div className="flex flex-col">
      <AnalyzeNav
        projectId={id}
        showAutoReview={showAutoReview}
        showArbitragem={showArbitragem}
      />
      <div className="flex-1">{children}</div>
    </div>
  );
}
