import "server-only";

import type { createSupabaseAdmin } from "@/lib/supabase/admin";

// Marca o assignment auto_revisao como concluido APENAS quando nao sobra
// nenhum field_review pendente do doc — o envio e parcial, entao um submit
// de subconjunto nao pode tirar o doc da fila.
export async function syncAutoRevisaoAssignmentStatus(
  admin: ReturnType<typeof createSupabaseAdmin>,
  projectId: string,
  documentId: string,
  userId: string,
  now: string,
): Promise<void> {
  const { data: stillPending } = await admin
    .from("field_reviews")
    .select("id")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("self_reviewer_id", userId)
    .is("self_verdict", null)
    .limit(1);

  if (!stillPending || stillPending.length === 0) {
    await admin
      .from("assignments")
      .update({ status: "concluido", completed_at: now })
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("user_id", userId)
      .eq("type", "auto_revisao");
  }
}
