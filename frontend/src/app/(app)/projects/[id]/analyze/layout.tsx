import { AnalyzeNav } from "@/components/analyze/AnalyzeNav";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import { computeAnalyzeTabVisibility } from "@/lib/analyze-tabs";
import { hasPendingArbitration } from "@/lib/arbitration-queue";
import { pendingAutoReviewsQuery } from "@/lib/auto-review-pending";
import type { AutomationMode } from "@/lib/types";

export default async function AnalyzeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  // Quais abas de revisão aparecem depende do modo de automação do projeto e
  // do trabalho ativo do usuário. Auto-revisão deriva de field_reviews,
  // arbitragem de assignments e field_reviews, e comparação de assignments.
  const [{ id }, user] = await Promise.all([params, requirePageAuthUser()]);
  const [supabase, rawAccess] = await Promise.all([
    createSupabaseServer(),
    getProjectAccessContext(id, user),
  ]);
  const access = requireResolvedProjectAccess(rawAccess);
  const { memberUserId, isCoordinator } = access;
  // Queries direcionadas com .limit(1) em vez de uma genérica com .limit(50),
  // que poderia mascarar um tipo se o membro canônico tiver muitos assignments
  // de outro. O probe da auto-revisão usa a regra da própria fila e, por
  // conferir o documento de cada linha, para na primeira que não é de
  // documento excluído; o da arbitragem cruza as duas regras da fila dela.
  const [
    { data: autoReviewRow, error: autoReviewError },
    { data: hasPendingArbitragem, error: arbitragemError },
    { data: comparacaoRow },
    { data: project },
  ] = await Promise.all([
    pendingAutoReviewsQuery(supabase, id)
      .eq("self_reviewer_id", memberUserId)
      .limit(1)
      .maybeSingle(),
    hasPendingArbitration(supabase, id, memberUserId),
    supabase
      .from("assignments")
      .select("id")
      .eq("project_id", id)
      .eq("user_id", memberUserId)
      .eq("type", "comparacao")
      .limit(1)
      .maybeSingle(),
    supabase
      .from("projects")
      .select("automation_mode")
      .eq("id", id)
      .single(),
  ]);

  // A aba some quando o probe falha; sem o log, some sem rastro.
  if (autoReviewError) {
    console.error(
      "AnalyzeLayout: probe de auto-revisão pendente falhou",
      autoReviewError.message,
    );
  }
  if (arbitragemError) {
    console.error(
      "AnalyzeLayout: probe de arbitragem aberta falhou",
      arbitragemError.message,
    );
  }

  const { showAutoReview, showArbitragem, showCompare } =
    computeAnalyzeTabVisibility({
      mode: project?.automation_mode as AutomationMode | undefined,
      isCoordinator,
      hasPendingAutoReview: autoReviewRow !== null,
      hasPendingArbitragem,
      hasComparacaoAssignment: comparacaoRow !== null,
    });

  return (
    <div className="flex flex-col">
      <AnalyzeNav
        projectId={id}
        showAutoReview={showAutoReview}
        showArbitragem={showArbitragem}
        showCompare={showCompare}
      />
      <div className="flex-1">{children}</div>
    </div>
  );
}
