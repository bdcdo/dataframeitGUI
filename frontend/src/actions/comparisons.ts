"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { requireCoordinator } from "@/lib/auth";
import { errorMessage } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import {
  scanComparisonBacklog,
  assignComparisonReviewer,
  loadOpenComparisonLoad,
  type ComparisonMode,
} from "@/lib/auto-comparison";

// Re-sorteia revisores para todo documento divergente sem comparação ativa
// (o "backlog" sem revisor). Disparada por setCanCompare ao habilitar/desabilitar
// um membro, para drenar o backlog acumulado enquanto não havia ninguém elegível.
// Espelha retryPendingArbitrations (actions/field-reviews.ts:1119).
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
    const gate = await requireCoordinator(
      projectId,
      "Apenas coordenadores podem reprocessar comparações.",
    );
    if (!gate.ok)
      return { success: false, error: gate.error, assigned: 0, stillNoPool: 0 };

    const supabase = await createSupabaseServer();

    // Só compare_humans/compare_llm têm backlog de comparação a drenar.
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("automation_mode")
      .eq("id", projectId)
      .single();
    if (projectError) throw new Error(projectError.message);
    const mode = project?.automation_mode;
    if (mode !== "compare_humans" && mode !== "compare_llm") {
      return { success: true, assigned: 0, stillNoPool: 0 };
    }

    const backlog = await scanComparisonBacklog(
      supabase,
      projectId,
      mode as ComparisonMode,
    );
    if (backlog.length === 0)
      return { success: true, assigned: 0, stillNoPool: 0 };

    // Carga aberta pré-computada uma vez; assignComparisonReviewer a incrementa
    // entre docs para preservar o balanceamento sem N queries (sequencial: cada
    // atribuição enxerga a carga atualizada da anterior).
    const loadByUser = await loadOpenComparisonLoad(supabase, projectId);

    let assigned = 0;
    let stillNoPool = 0;
    for (const { documentId, coderIds } of backlog) {
      // Sequencial intencional (ver comentário acima): cada atribuição enxerga
      // a carga atualizada da anterior; paralelizar degradaria o balanceamento.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await assignComparisonReviewer(
        supabase,
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
      error: errorMessage(e) || "Erro",
      assigned: 0,
      stillNoPool: 0,
    };
  }
}
