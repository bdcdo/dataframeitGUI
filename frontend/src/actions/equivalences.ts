"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { resolveProjectMemberActor } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { syncCompareAssignment } from "@/lib/compare-sync";
import { canonicalPair } from "@/lib/equivalence";
import { errorMessage } from "@/lib/utils";
import type { ResponseSnapshotEntry } from "@/actions/reviews";

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
  responseSnapshot?: ResponseSnapshotEntry[],
): Promise<{ error?: string }> {
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
    const { error: equivErr } = await supabase
      .from("response_equivalences")
      .upsert(rows, {
        onConflict: "project_id,document_id,field_name,response_a_id,response_b_id",
        ignoreDuplicates: true,
      });
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
    const { error } = await supabase.from("response_equivalences").upsert(
      {
        project_id: projectId,
        document_id: documentId,
        field_name: fieldName,
        response_a_id: a,
        response_b_id: b,
        reviewer_id: reviewerId,
      },
      {
        onConflict:
          "project_id,document_id,field_name,response_a_id,response_b_id",
        ignoreDuplicates: true,
      },
    );
    if (error) throw new Error(error.message);
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao marcar equivalentes." };
  }

  revalidatePath(`/projects/${projectId}/reviews/llm-insights`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  return {};
}

// Removes a single equivalence pair. Also clears the current reviewer's
// verdict for the affected (doc, field), since the previously chosen
// gabarito no longer represents a fused group — forcing a fresh vote.
export async function unmarkEquivalencePair(
  projectId: string,
  equivalenceId: string,
): Promise<{ error?: string }> {
  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { error: actor.error };
  const reviewerId = actor.memberUserId;

  const supabase = await createSupabaseServer();

  try {
    const { data: row } = await supabase
      .from("response_equivalences")
      .select("document_id, field_name")
      .eq("id", equivalenceId)
      .eq("project_id", projectId)
      .maybeSingle();

    // Ordem obrigatória, não awaits independentes: o select acima captura
    // document_id/field_name ANTES de a linha ser apagada. Paralelizar com o
    // delete criaria uma race read-after-delete (row viria null e a limpeza de
    // reviews abaixo não rodaria).
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const { error } = await supabase
      .from("response_equivalences")
      .delete()
      .eq("id", equivalenceId)
      .eq("project_id", projectId);
    if (error) throw new Error(error.message);

    if (row?.document_id && row.field_name) {
      await supabase
        .from("reviews")
        .delete()
        .eq("project_id", projectId)
        .eq("document_id", row.document_id)
        .eq("field_name", row.field_name)
        .eq("reviewer_id", reviewerId);

      await syncCompareAssignment(
        supabase,
        projectId,
        row.document_id,
        reviewerId,
      );
    }
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao desfazer equivalência." };
  }

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  return {};
}
