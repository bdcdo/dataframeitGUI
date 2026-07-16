import "server-only";

import type { createSupabaseAdmin } from "@/lib/supabase/admin";

// Marca o assignment auto_revisao como concluido APENAS quando nao sobra
// nenhum field_review pendente do doc — o envio e parcial, entao um submit
// de subconjunto nao pode tirar o doc da fila.
//
// A decisao vive na RPC, sob a trava que o produtor tambem pega — ver migration
// 20260716130000.
export async function syncAutoRevisaoAssignmentStatus(
  admin: ReturnType<typeof createSupabaseAdmin>,
  projectId: string,
  documentId: string,
  userId: string,
): Promise<void> {
  const { error } = await admin.rpc("sync_auto_review_assignment_status", {
    p_project_id: projectId,
    p_document_id: documentId,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);
}
