"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getEffectiveMemberId } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { syncCompareAssignment } from "@/lib/compare-sync";
import { canonicalPair } from "@/lib/equivalence";
import { errorMessage } from "@/lib/utils";
import { ZeroRowsError } from "@/lib/supabase/rls-guard";
import type { ResponseSnapshotEntry } from "@/actions/reviews";

type EquivalenceActionContext =
  | {
      ok: true;
      effectiveId: string;
      supabase: Awaited<ReturnType<typeof createSupabaseServer>>;
    }
  | { ok: false; error: string };

// As três actions compartilham o mesmo contrato: falhas ao resolver a
// identidade canônica ou criar o client viram `{ error }`, nunca uma rejeição
// opaca do Server Action. A resolução e a criação são independentes.
async function resolveEquivalenceActionContext(
  projectId: string,
): Promise<EquivalenceActionContext> {
  try {
    const [effectiveId, supabase] = await Promise.all([
      getEffectiveMemberId(projectId),
      createSupabaseServer(),
    ]);
    return { ok: true, effectiveId, supabase };
  } catch (error) {
    return {
      ok: false,
      error:
        errorMessage(error) ||
        "Falha ao resolver a identidade efetiva do revisor.",
    };
  }
}

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
    return {
      error: "Gabarito precisa estar na lista de respostas selecionadas.",
    };
  }

  // Identidade de trabalho no projeto (spec 002): a conta vinculada cria a
  // equivalência e o review como o membro canônico.
  const context = await resolveEquivalenceActionContext(projectId);
  if (!context.ok) return { error: context.error };
  const { effectiveId, supabase } = context;

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
        reviewer_id: effectiveId,
      });
    }
  }

  try {
    const { error: equivErr } = await supabase
      .from("response_equivalences")
      .upsert(rows, {
        onConflict:
          "project_id,document_id,field_name,response_a_id,response_b_id",
        ignoreDuplicates: true,
      });
    if (equivErr) throw new Error(equivErr.message);

    const { error: reviewErr } = await supabase.from("reviews").upsert(
      {
        project_id: projectId,
        document_id: documentId,
        field_name: fieldName,
        reviewer_id: effectiveId,
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
    await syncCompareAssignment(supabase, projectId, documentId, effectiveId);
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

  const context = await resolveEquivalenceActionContext(projectId);
  if (!context.ok) return { error: context.error };
  const { effectiveId, supabase } = context;
  const [a, b] = canonicalPair(llmResponseId, chosenResponseId);

  try {
    const { error } = await supabase.from("response_equivalences").upsert(
      {
        project_id: projectId,
        document_id: documentId,
        field_name: fieldName,
        response_a_id: a,
        response_b_id: b,
        reviewer_id: effectiveId,
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
  const context = await resolveEquivalenceActionContext(projectId);
  if (!context.ok) return { error: context.error };
  const { effectiveId, supabase } = context;

  let deletedPair: { document_id: string; field_name: string };

  try {
    const { data, error } = await supabase.rpc("unmark_response_equivalence", {
      p_project_id: projectId,
      p_equivalence_id: equivalenceId,
      p_reviewer_id: effectiveId,
    });
    if (error) throw new Error(error.message);

    const [pair] = (data ?? []) as Array<{
      document_id: string;
      field_name: string;
    }>;
    if (!pair) {
      throw new ZeroRowsError(
        "response_equivalences",
        "delete",
        "Equivalência não encontrada ou sem permissão para removê-la.",
      );
    }
    deletedPair = pair;
  } catch (e) {
    return { error: errorMessage(e) || "Falha ao desfazer equivalência." };
  }

  // Pós-commit best-effort: a RPC já removeu equivalência e review numa
  // transação. `syncCompareAssignment` lança desde o #499, então mantê-lo
  // dentro do try acima faria uma falha de sync virar "falha ao desfazer" sobre
  // uma escrita já persistida — a revisora tentaria de novo sobre uma linha que
  // não existe mais, e a revalidação nem rodaria. Loga e segue.
  try {
    await syncCompareAssignment(
      supabase,
      projectId,
      deletedPair.document_id,
      effectiveId,
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
