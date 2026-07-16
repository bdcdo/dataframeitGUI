"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { resolveProjectActor } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { finalizeCompareWrite } from "@/lib/compare-sync";
import { errorMessage } from "@/lib/utils";

export async function submitVerdict(
  projectId: string,
  documentId: string,
  fieldName: string,
  verdict: string,
  chosenResponseId?: string,
  comment?: string,
  comparisonResponseIds: string[] = [],
): Promise<{ error?: string }> {
  const actor = await resolveProjectActor(projectId);
  if (!actor.ok) return { error: actor.error };

  // Identidade de trabalho no projeto (spec 002): conta vinculada revisa
  // como o membro canônico — reviewer_id, author_id e o sync do assignment
  // usam o id efetivo, casando com o onConflict do upsert.
  const effectiveId = actor.effectiveUserId;
  const supabase = await createSupabaseServer();

  try {
    const { error } = await supabase.rpc("submit_compare_review", {
      p_project_id: projectId,
      p_document_id: documentId,
      p_field_name: fieldName,
      p_reviewer_id: effectiveId,
      p_verdict: verdict,
      p_chosen_response_id: chosenResponseId || null,
      p_comment: comment?.trim() || null,
      p_comparison_response_ids: comparisonResponseIds,
      p_equivalent_response_ids: null,
    });

    if (error) throw new Error(error.message);
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao salvar o veredito" };
  }

  finalizeCompareWrite({
    supabase,
    projectId,
    documentId,
    userId: effectiveId,
    operation: "submitVerdict",
    revalidateComments: true,
  });

  return {};
}

// Para docs sem divergência (revisor decide fechar manualmente).
export async function markCompareDocReviewed(
  projectId: string,
  documentId: string,
): Promise<{ error?: string }> {
  const actor = await resolveProjectActor(projectId);
  if (!actor.ok) return { error: actor.error };

  // Conta vinculada fecha o doc como o membro canônico (spec 002).
  // Awaits independentes em paralelo.
  const effectiveId = actor.effectiveUserId;
  const supabase = await createSupabaseServer();

  const { error } = await supabase
    .from("assignments")
    .update({ status: "concluido", completed_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", effectiveId)
    .eq("type", "comparacao");

  if (error) {
    return { error: error.message || "Erro ao marcar o documento como revisado" };
  }

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  return {};
}
