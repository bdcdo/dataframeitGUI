import type { SupabaseServerClient } from "@/lib/supabase/server";
import { profileDisplayName } from "@/lib/respondent-names";

/**
 * Nome de cada revisor (o do perfil; sem nome, a parte local do e-mail), por
 * id, para as abas de Revisões. Sem ids, nenhuma query.
 */
export async function loadReviewerNames(
  supabase: Pick<SupabaseServerClient, "from">,
  reviewerIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(reviewerIds)];
  if (ids.length === 0) return new Map();
  const { data: profiles } = await supabase.from("profiles").select("id, email, first_name, last_name").in("id", ids);
  return new Map((profiles ?? []).map((profile) => [profile.id, profileDisplayName(profile)]));
}
