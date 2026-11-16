import { AnalyzeNav } from "@/components/analyze/AnalyzeNav";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import { computeAnalyzeTabVisibility } from "@/lib/analyze-tabs";
import {
  openArbitrationAssignmentsQuery,
  pendingArbitrationFieldProbe,
} from "@/lib/arbitration-queue";
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
  // de outro. Os probes da auto-revisão e da arbitragem usam as regras da
  // própria fila e, por conferirem o documento de cada linha, param na
  // primeira que não é de documento excluído.
  const [
    { data: autoReviewRow, error: autoReviewError },
    { data: arbitragemRow, error: arbitragemError },
    { data: arbitragemFieldRow, error: arbitragemFieldError },
    { data: comparacaoRow },
    { data: project },
  ] = await Promise.all([
    pendingAutoReviewsQuery(supabase, id)
      .eq("self_reviewer_id", memberUserId)
      .limit(1)
      .maybeSingle(),
    openArbitrationAssignmentsQuery(supabase, id, memberUserId)
      .limit(1)
      .maybeSingle(),
    pendingArbitrationFieldProbe(supabase, id, memberUserId)
      .limit(1)
      .maybeSingle(),
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
  const arbitrationProbeError = arbitragemError ?? arbitragemFieldError;
  if (arbitrationProbeError) {
    console.error(
      "AnalyzeLayout: probe de arbitragem aberta falhou",
      arbitrationProbeError.message,
    );
  }

  const { showAutoReview, showArbitragem, showCompare } =
    computeAnalyzeTabVisibility({
      mode: project?.automation_mode as AutomationMode | undefined,
      isCoordinator,
      hasPendingAutoReview: autoReviewRow !== null,
      hasPendingArbitragem:
        arbitragemRow !== null && arbitragemFieldRow !== null,
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
