import "server-only";

import type { SupabaseServerClient } from "@/lib/supabase/server";
import { isCodingComplete } from "@/lib/coding-completeness";
import { createAutoReviewIfDiverges } from "@/lib/auto-review";
import { createAutoComparisonIfDiverges } from "@/lib/auto-comparison";
import type { PydanticField } from "@/lib/types";

async function runCodingAutomation(
  mode: string | null | undefined,
  projectId: string,
  documentId: string,
  // Falso positivo: `userId` só restringe SELECT/UPDATE pelas policies RLS;
  // a automação chamada abaixo já audita as escritas via admin client.
  // react-doctor-disable-next-line react-doctor/supabase-client-owned-authz-field
  userId: string,
): Promise<void> {
  // Dispara a automacao do projeto ao submeter, conforme automation_mode.
  // Falhas nao bloqueiam o submit do pesquisador — o coordenador pode
  // regenerar o backlog manualmente (regenerateAutoReviewBacklog /
  // retryPendingComparisons). "none" nao dispara nada.
  try {
    if (mode === "auto_review_llm") {
      await createAutoReviewIfDiverges(projectId, documentId, userId);
    } else if (mode === "compare_humans") {
      await createAutoComparisonIfDiverges(projectId, documentId, "compare_humans");
    } else if (mode === "compare_llm") {
      await createAutoComparisonIfDiverges(projectId, documentId, "compare_llm");
    }
  } catch (err) {
    // Log estruturado JSON — mesmo formato dos demais eventos das libs de
    // automacao, facilita grep "[auto-review]" / "[auto-compare]" nos logs.
    const prefix = mode === "auto_review_llm" ? "[auto-review]" : "[auto-compare]";
    console.error(
      `${prefix} ${JSON.stringify({
        event: "inline_call_failed",
        mode,
        projectId,
        documentId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      })}`,
    );
  }
}

export interface SyncCodingAssignmentParams {
  projectId: string;
  documentId: string;
  userId: string;
  fields: PydanticField[];
  sanitizedAnswers: Record<string, unknown>;
  isAutoSave: boolean;
  automationMode: string | null | undefined;
}

// Recomputes the reviewer's "codificacao" assignment status right after a
// save: completes it (and fires the project's automation) when every field
// is answered and this isn't an autosave; otherwise regresses it back to
// em_andamento — but never out of concluido, so autosave never undoes
// progress. Mirrors the "recompute + update assignment" shape already
// established by the explicit comparison-assignment workflow for the
// "comparacao" assignment type.
export async function syncCodingAssignmentStatus(
  supabase: SupabaseServerClient,
  params: SyncCodingAssignmentParams,
): Promise<{ error?: string }> {
  const { projectId, documentId, userId, fields, sanitizedAnswers, isAutoSave, automationMode } =
    params;

  // Definição única de "codificação completa" — ver lib/coding-completeness.
  // O mesmo helper gateia o backlog de auto-revisão (issue #174).
  const allAnswered = isCodingComplete(fields, sanitizedAnswers);

  // Auto-save nunca promove para "concluido" — mesmo que todos os campos
  // estejam preenchidos, o pesquisador ainda nao clicou em Enviar. Sem essa
  // guarda, sair da pagina dispara visibilitychange -> saveResponse -> doc
  // some da lista no filtro padrao por virar current_done.
  if (allAnswered && !isAutoSave) {
    const { error: assignErr } = await supabase
      .from("assignments")
      .update({ status: "concluido", completed_at: new Date().toISOString() })
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("user_id", userId)
      .eq("type", "codificacao");
    if (assignErr) return { error: assignErr.message };

    await runCodingAutomation(automationMode, projectId, documentId, userId);
    return {};
  }

  // So regredir se NAO esta concluido (evita desfazer progresso por auto-save)
  const { data: currentAssignment } = await supabase
    .from("assignments")
    .select("status")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .eq("type", "codificacao")
    .maybeSingle();

  if (currentAssignment && currentAssignment.status !== "concluido") {
    const { error: assignErr } = await supabase
      .from("assignments")
      .update({ status: "em_andamento", completed_at: null })
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("user_id", userId)
      .eq("type", "codificacao");
    if (assignErr) return { error: assignErr.message };
  }
  return {};
}
