import "server-only";

import type { SupabaseServerClient } from "@/lib/supabase/server";

// A RPC serializa a liberação/reabertura concorrente e o fechamento pela mesma
// chave; SELECT→UPDATE em requests separados poderia esconder um campo pendente
// novo e tirar o documento da fila com trabalho por fazer.
export async function syncAutoRevisaoAssignmentStatus(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase.rpc("sync_auto_review_assignment_status", {
    p_project_id: projectId,
    p_document_id: documentId,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);
}
