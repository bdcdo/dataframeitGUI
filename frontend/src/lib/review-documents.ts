import type { SupabaseServerClient } from "@/lib/supabase/server";

export async function loadActiveReviewDocuments(
  supabase: SupabaseServerClient,
  documentIds: string[],
) {
  return supabase
    .from("documents")
    .select("id, title, external_id, text")
    .in("id", documentIds)
    .is("excluded_at", null)
    .is("exclusion_pending_at", null);
}
