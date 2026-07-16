import "server-only";

import type { createSupabaseAdmin } from "@/lib/supabase/admin";

// Marca o assignment auto_revisao como concluido APENAS quando nao sobra
// nenhum field_review pendente do doc — o envio e parcial, entao um submit
// de subconjunto nao pode tirar o doc da fila.
//
// A decisao vive na RPC porque ler as pendencias aqui e gravar 'concluido' em
// seguida sao duas requests: um stub liberado no intervalo por
// assign_auto_review_if_eligible ficaria invisivel, e o documento sairia da fila
// com veredito por fazer. A RPC serializa os dois lados pela mesma chave.
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
