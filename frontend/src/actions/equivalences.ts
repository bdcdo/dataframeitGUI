"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { scheduleCompareRevalidation } from "@/lib/compare-revalidation";
import { canonicalPair } from "@/lib/equivalence";
import { errorMessage } from "@/lib/utils";

// Marks two or more responses as equivalent for a (document, field) and at the
// same time records the verdict pointing to `gabaritoId` — the response that
// represents the canonical answer in the database. The action is idempotent:
// duplicate pairs are ignored via the UNIQUE constraint.
export async function confirmEquivalentVerdict(
  projectId: string,
  documentId: string,
  fieldName: string,
  responseIds: string[],
  gabaritoId: string,
  verdictDisplay: string,
  comment?: string,
  comparisonResponseIds: string[] = [],
  completeAssignment = false,
): Promise<{ error?: string }> {
  if (responseIds.length < 2) {
    return { error: "Marcar como equivalentes exige 2+ respostas." };
  }
  if (!responseIds.includes(gabaritoId)) {
    return { error: "Gabarito precisa estar na lista de respostas selecionadas." };
  }

  const supabase = await createSupabaseServer();

  try {
    const { error } = await supabase.rpc("submit_compare_review", {
      p_project_id: projectId,
      p_document_id: documentId,
      p_field_name: fieldName,
      p_verdict: verdictDisplay,
      p_chosen_response_id: gabaritoId,
      p_comment: comment?.trim() || null,
      p_comparison_response_ids: comparisonResponseIds,
      p_equivalent_response_ids: responseIds,
      p_complete_assignment: completeAssignment,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao marcar equivalentes." };
  }

  scheduleCompareRevalidation(projectId, "confirmEquivalentVerdict");
  return {};
}

// Lightweight variant for the "Erros LLM" tab: registers that the LLM
// response and the reviewer-chosen response are equivalent, without
// touching the existing review row (the verdict already points to
// `chosenResponseId` and remains valid). The page recomputes errors and
// suppresses entries whose LLM↔chosen pair is in `response_equivalences`.
export async function markLlmEquivalent(
  projectId: string,
  documentId: string,
  fieldName: string,
  llmResponseId: string,
  chosenResponseId: string,
): Promise<{ error?: string }> {
  if (llmResponseId === chosenResponseId) {
    return { error: "Respostas já são as mesmas." };
  }

  const supabase = await createSupabaseServer();
  const [a, b] = canonicalPair(llmResponseId, chosenResponseId);

  try {
    const { error } = await supabase.rpc("add_response_equivalence", {
      p_project_id: projectId,
      p_document_id: documentId,
      p_field_name: fieldName,
      p_response_a_id: a,
      p_response_b_id: b,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao marcar equivalentes." };
  }

  scheduleCompareRevalidation(projectId, "markLlmEquivalent", {
    llmInsights: true,
  });
  return {};
}

// Removes a single equivalence pair. Also clears the current reviewer's
// verdict for the affected (doc, field), since the previously chosen
// gabarito no longer represents a fused group — forcing a fresh vote.
export async function unmarkEquivalencePair(
  projectId: string,
  equivalenceId: string,
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServer();

  try {
    const { error } = await supabase.rpc("remove_response_equivalence", {
      p_project_id: projectId,
      p_equivalence_id: equivalenceId,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao desfazer equivalência." };
  }

  scheduleCompareRevalidation(projectId, "unmarkEquivalencePair");
  return {};
}
