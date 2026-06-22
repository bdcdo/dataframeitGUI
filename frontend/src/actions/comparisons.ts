"use server";

import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getAuthUser, isProjectCoordinator } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import {
  scanComparisonBacklog,
  assignComparisonReviewer,
  type ComparisonMode,
} from "@/lib/auto-comparison";

// Re-sorteia revisores para todo documento divergente sem comparação ativa
// (o "backlog" sem revisor). Disparada por setCanCompare ao habilitar/desabilitar
// um membro, para drenar o backlog acumulado enquanto não havia ninguém elegível.
// Espelha retryPendingArbitrations (actions/field-reviews.ts:1118).
//
// Diferença estrutural: a comparação não materializa divergência (não há stub
// como field_reviews), então o backlog é recomputado por varredura — ver
// scanComparisonBacklog (varredura em 2 fases).
export async function retryPendingComparisons(projectId: string): Promise<{
  success: boolean;
  error?: string;
  assigned: number;
  stillNoPool: number;
}> {
  try {
    const user = await getAuthUser();
    if (!user)
      return { success: false, error: "Não autenticado", assigned: 0, stillNoPool: 0 };
    const isCoord = await isProjectCoordinator(projectId, user);
    if (!isCoord)
      return {
        success: false,
        error: "Apenas coordenadores podem reprocessar comparações.",
        assigned: 0,
        stillNoPool: 0,
      };

    const admin = createSupabaseAdmin();

    // Só compare_humans/compare_llm têm backlog de comparação a drenar.
    const { data: project } = await admin
      .from("projects")
      .select("automation_mode")
      .eq("id", projectId)
      .single();
    const mode = project?.automation_mode;
    if (mode !== "compare_humans" && mode !== "compare_llm") {
      return { success: true, assigned: 0, stillNoPool: 0 };
    }

    const backlog = await scanComparisonBacklog(admin, projectId, mode as ComparisonMode);
    if (backlog.length === 0) return { success: true, assigned: 0, stillNoPool: 0 };

    // Carga aberta pré-computada uma vez; assignComparisonReviewer a incrementa
    // entre docs para preservar o balanceamento sem N queries (sequencial: cada
    // atribuição enxerga a carga atualizada da anterior).
    const { data: openCounts } = await admin
      .from("assignments")
      .select("user_id")
      .eq("project_id", projectId)
      .eq("type", "comparacao")
      .neq("status", "concluido");
    const loadByUser = new Map<string, number>();
    for (const r of openCounts ?? []) {
      loadByUser.set(r.user_id, (loadByUser.get(r.user_id) ?? 0) + 1);
    }

    let assigned = 0;
    let stillNoPool = 0;
    for (const { documentId, coderIds } of backlog) {
      const result = await assignComparisonReviewer(
        admin,
        projectId,
        documentId,
        coderIds,
        loadByUser,
      );
      if (result.assigned) assigned++;
      if (result.noPool) stillNoPool++;
    }

    revalidatePath(`/projects/${projectId}/analyze/compare`);
    revalidatePath(`/projects/${projectId}/config/members`);
    return { success: true, assigned, stillNoPool };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "Erro",
      assigned: 0,
      stillNoPool: 0,
    };
  }
}
