"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { resolveProjectMemberActor } from "@/lib/auth";
import { revalidatePath } from "next/cache";

/**
 * `acknowledgedVerdict` é o veredito que a tela mostrou. O banco guarda com o
 * reconhecimento e só aceita gravar se ele ainda é o veredito da review: a
 * review rearbitrada entre a tela e o clique volta como erro (#758).
 */
export async function acknowledgeVerdict(
  reviewId: string,
  projectId: string,
  status: "accepted" | "questioned",
  acknowledgedVerdict: string,
  comment?: string,
): Promise<{ error?: string }> {
  const actor = await resolveProjectMemberActor(projectId);
  if (!actor.ok) return { error: actor.error };
  const respondentId = actor.memberUserId;

  const supabase = await createSupabaseServer();

  const { error } = await supabase.from("verdict_acknowledgments").upsert(
    {
      review_id: reviewId,
      respondent_id: respondentId,
      status,
      comment: comment || null,
      acknowledged_verdict: acknowledgedVerdict,
    },
    { onConflict: "review_id,respondent_id" },
  );

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/reviews/my-verdicts`);
  return {};
}
