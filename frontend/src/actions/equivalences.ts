"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { syncCompareAssignment } from "@/lib/compare-sync";
import { canonicalPair } from "@/lib/equivalence";
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
) {
  if (responseIds.length < 2) {
    throw new Error("Marcar como equivalentes exige 2+ respostas.");
  }
  if (!responseIds.includes(gabaritoId)) {
    throw new Error("Gabarito precisa estar na lista de respostas selecionadas.");
  }

  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

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
        reviewer_id: user.id,
      });
    }
  }

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
      reviewer_id: user.id,
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

  await syncCompareAssignment(supabase, projectId, documentId, user.id);

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
}

// Removes a single equivalence pair. Also clears the current reviewer's
// verdict for the affected (doc, field), since the previously chosen
// gabarito no longer represents a fused group — forcing a fresh vote.
export async function unmarkEquivalencePair(
  projectId: string,
  equivalenceId: string,
) {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();

  const { data: row } = await supabase
    .from("response_equivalences")
    .select("document_id, field_name")
    .eq("id", equivalenceId)
    .eq("project_id", projectId)
    .maybeSingle();

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
      .eq("reviewer_id", user.id);

    await syncCompareAssignment(supabase, projectId, row.document_id, user.id);
  }

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
}
