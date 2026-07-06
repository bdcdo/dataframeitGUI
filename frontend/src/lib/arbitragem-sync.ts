import "server-only";

import type { SupabaseServerClient } from "@/lib/supabase/server";

// Pending check + assignment update via supabase: SELECT cabe na policy
// "Members view own field_reviews" e UPDATE cabe na "Researchers update
// own assignments". Sem admin aqui.
export async function syncArbitragemAssignmentStatus(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  // Falso positivo: `userId` só restringe SELECT/UPDATE pelas policies RLS;
  // o payload do UPDATE não escreve campo de autorização.
  // react-doctor-disable-next-line react-doctor/supabase-client-owned-authz-field
  userId: string,
  now: string,
): Promise<void> {
  const { data: pending } = await supabase
    .from("field_reviews")
    .select("id")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("arbitrator_id", userId)
    .is("final_verdict", null)
    .limit(1);

  if (!pending || pending.length === 0) {
    await supabase
      .from("assignments")
      .update({ status: "concluido", completed_at: now })
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("user_id", userId)
      .eq("type", "arbitragem");
  }
}
