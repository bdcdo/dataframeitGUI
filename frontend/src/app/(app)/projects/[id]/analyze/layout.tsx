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
  // correspondentes. Coordenador sempre ve. Pesquisador ve enquanto tiver
  // pelo menos um assignment do tipo (pendente, em_andamento OU concluido) —
  // preserva acesso ao historico mesmo apos a fila zerar.
  const user = await getAuthUser();
  let showAutoReview = false;
  let showArbitragem = false;

  if (user) {
    const supabase = await createSupabaseServer();
    // Duas queries direcionadas com .limit(1) em vez de uma query genérica com
    // .limit(50): se o usuario tiver muitos assignments de um tipo, o teto de
    // 50 ainda poderia mascarar o outro tipo. .limit(1) é O(1) com o index
    // (project_id, user_id, type).
    const [{ data: autoReviewRow }, { data: arbitragemRow }, isCoord] =
      await Promise.all([
        supabase
          .from("assignments")
          .select("id")
          .eq("project_id", id)
          .eq("user_id", user.id)
          .eq("type", "auto_revisao")
          .limit(1)
          .maybeSingle(),
        supabase
          .from("assignments")
          .select("id")
          .eq("project_id", id)
          .eq("user_id", user.id)
          .eq("type", "arbitragem")
          .limit(1)
          .maybeSingle(),
        isProjectCoordinator(supabase, id, user),
      ]);

    showAutoReview = isCoord || autoReviewRow !== null;
    showArbitragem = isCoord || arbitragemRow !== null;
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
