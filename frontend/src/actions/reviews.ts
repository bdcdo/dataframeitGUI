"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { scheduleCompareRevalidation } from "@/lib/compare-revalidation";
import { errorMessage } from "@/lib/utils";

export async function submitVerdict(
  projectId: string,
  documentId: string,
  fieldName: string,
  verdict: string,
  chosenResponseId?: string,
  comment?: string,
  comparisonResponseIds: string[] = [],
  completeAssignment = false,
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServer();

  try {
    const { error } = await supabase.rpc("submit_compare_review", {
      p_project_id: projectId,
      p_document_id: documentId,
      p_field_name: fieldName,
      p_verdict: verdict,
      p_chosen_response_id: chosenResponseId || null,
      p_comment: comment?.trim() || null,
      p_comparison_response_ids: comparisonResponseIds,
      p_equivalent_response_ids: null,
      p_complete_assignment: completeAssignment,
    });

    if (error) throw new Error(error.message);
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao salvar o veredito" };
  }

  scheduleCompareRevalidation(projectId, "submitVerdict", {
    comments: true,
  });

  return {};
}

// Para docs sem divergência (revisor decide fechar manualmente).
export async function markCompareDocReviewed(
  projectId: string,
  documentId: string,
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServer();
  const { error } = await supabase.rpc("mark_compare_doc_reviewed", {
    p_project_id: projectId,
    p_document_id: documentId,
  });

  if (error) {
    return { error: error.message || "Erro ao marcar o documento como revisado" };
  }

  scheduleCompareRevalidation(projectId, "markCompareDocReviewed");
  return {};
}
