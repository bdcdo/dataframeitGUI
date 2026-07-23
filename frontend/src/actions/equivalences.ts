"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { resolveProjectMemberActor } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { syncCompareAssignment } from "@/lib/compare-sync";
import { canonicalPair } from "@/lib/equivalence";
import { errorMessage } from "@/lib/utils";
import { ZeroRowsError } from "@/lib/supabase/rls-guard";
import type { ResponseSnapshotEntry } from "@/actions/reviews";

// Marks two or more responses as equivalent for a (document, field) and at the
// same time records the verdict pointing to `gabaritoId` — the response that
// represents the canonical answer in the database. The action is idempotent:
// duplicate pairs are ignored via the UNIQUE constraint.
export interface ConfirmEquivalentVerdictInput {
  projectId: string;
  documentId: string;
  fieldName: string;
  responseIds: string[];
  gabaritoId: string;
  verdictDisplay: string;
  comment?: string;
  responseSnapshot?: ResponseSnapshotEntry[];
}

export async function confirmEquivalentVerdict({
  projectId,
  documentId,
  fieldName,
  responseIds,
  gabaritoId,
  verdictDisplay,
  comment,
  responseSnapshot,
}: ConfirmEquivalentVerdictInput): Promise<{ error?: string }> {
  if (responseIds.length < 2) {
    return { error: "Marcar como equivalentes exige 2+ respostas." };
  }
  if (!responseIds.includes(gabaritoId)) {
    return { error: "Gabarito precisa estar na lista de respostas selecionadas." };
  }

  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { error: actor.error };
  const reviewerId = actor.memberUserId;

  const supabase = await createSupabaseServer();

  // Build canonical pairs (a < b) for every combination, dedup.
  const seen = new Set<string>();
  const rows: Array<{
    project_id: string;
    document_id: string;
    field_name: string;
    response_a_id: string;
    response_b_id: string;
    reviewer_id: string;
  }> = [];
  for (let i = 0; i < responseIds.length; i++) {
    for (let j = i + 1; j < responseIds.length; j++) {
      const [a, b] = canonicalPair(responseIds[i], responseIds[j]);
      const key = `${a}|${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        project_id: projectId,
        document_id: documentId,
        field_name: fieldName,
        response_a_id: a,
        response_b_id: b,
        reviewer_id: reviewerId,
      });
    }
  }

  try {
    const { error: equivErr } = await supabase.rpc(
      "record_response_equivalences",
      { p_rows: rows },
    );
    if (equivErr) throw new Error(equivErr.message);

    const { error: reviewErr } = await supabase.from("reviews").upsert(
      {
        project_id: projectId,
        document_id: documentId,
        field_name: fieldName,
        reviewer_id: reviewerId,
        verdict: verdictDisplay,
        chosen_response_id: gabaritoId,
        comment: comment || null,
        response_snapshot: responseSnapshot ?? null,
      },
      {
        onConflict: "project_id,document_id,field_name,reviewer_id",
      },
    );
    if (reviewErr) throw new Error(reviewErr.message);
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao marcar equivalentes." };
  }

  // Pós-commit best-effort: as equivalências e o review já foram gravados. Uma
  // falha do sync não deve virar { error } (o client refaria uma escrita já
  // persistida). Loga e segue para a revalidação.
  try {
    await syncCompareAssignment(supabase, projectId, documentId, reviewerId);
  } catch (e) {
    console.error(
      `[confirmEquivalentVerdict] falha ao sincronizar o assignment: ${errorMessage(e)}`,
    );
  }

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
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

  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { error: actor.error };
  const reviewerId = actor.memberUserId;

  const supabase = await createSupabaseServer();
  const [a, b] = canonicalPair(llmResponseId, chosenResponseId);

  try {
    const { error } = await supabase.rpc("record_response_equivalences", {
      p_rows: [{
        project_id: projectId,
        document_id: documentId,
        field_name: fieldName,
        response_a_id: a,
        response_b_id: b,
        reviewer_id: reviewerId,
      }],
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao marcar equivalentes." };
  }

  revalidatePath(`/projects/${projectId}/reviews/llm-insights`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  return {};
}

// Removes a single equivalence pair. The RPC also clears the calling
// identity's verdict for the affected (doc, field) in the same transaction,
// since the previously chosen gabarito no longer represents a fused group —
// forcing a fresh vote. A coordinator undoing someone else's pair does not
// erase that person's verdict.
export async function unmarkEquivalencePair(
  projectId: string,
  equivalenceId: string,
): Promise<{ error?: string }> {
  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { error: actor.error };
  const reviewerId = actor.memberUserId;

  const supabase = await createSupabaseServer();
  let syncDocumentId: string;

  try {
    // A RPC remove o par e o veredito da identidade de trabalho na mesma
    // transação — o DELETE de `reviews` não vive mais aqui.
    const { data, error } = await supabase.rpc("remove_response_equivalence", {
      p_project_id: projectId,
      p_equivalence_id: equivalenceId,
    });
    if (error) throw new Error(error.message);

    // Conjunto vazio significa linha inexistente OU autoridade que não bate: a
    // RPC não distingue, e nenhum dos dois é sucesso. Sem este guard a action
    // retornaria `{}` sobre nada removido e a revisora veria "desfeito" — o
    // sucesso falso do #178.
    const row = data?.[0];
    if (!row?.document_id || !row.field_name) {
      throw new ZeroRowsError(
        "response_equivalences",
        "delete",
        "Equivalência não encontrada ou sem permissão para removê-la.",
      );
    }
    syncDocumentId = row.document_id;
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao desfazer equivalência." };
  }

  // Pós-commit best-effort: a equivalência e o review já foram apagados. Uma
  // falha do sync não deve virar { error } — a revisora veria "falha ao
  // desfazer" para uma operação já persistida e tentaria de novo, sobre uma
  // linha que não existe mais. Loga e segue para a revalidação.
  //
  // `reviewerId` resolve a identidade de trabalho no Node
  // (`resolveProjectMemberActor`) enquanto o DELETE dentro da RPC resolve a
  // dele em SQL (`auth_user_member_identity_ids`): duas fontes que precisam
  // concordar para o assignment recalculado ser o da identidade cujo veredito
  // saiu. Eliminar a segunda por construção exigiria a RPC devolver o
  // `reviewer_id` efetivo — o que muda o `RETURNS TABLE` e quebraria a
  // compatibilidade de assinatura que permite aplicar a migration antes do
  // merge do código. Fica como follow-up, não como fallback aqui.
  try {
    await syncCompareAssignment(
      supabase,
      projectId,
      syncDocumentId,
      reviewerId,
    );
  } catch (e) {
    console.error(
      `[unmarkEquivalencePair] falha ao sincronizar o assignment: ${errorMessage(e)}`,
    );
  }

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  return {};
}
