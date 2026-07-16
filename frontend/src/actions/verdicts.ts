"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { resolveProjectActor } from "@/lib/auth";
import { revalidatePath } from "next/cache";

export async function acknowledgeVerdict(
  reviewId: string,
  projectId: string,
  status: "accepted" | "questioned",
  comment?: string,
): Promise<{ error?: string }> {
  const actor = await resolveProjectActor(projectId);
  if (!actor.ok) return { error: actor.error };
  const supabase = await createSupabaseServer();
  const effectiveMemberId = actor.effectiveUserId;

  const { error } = await supabase.from("verdict_acknowledgments").upsert(
    {
      review_id: reviewId,
      respondent_id: effectiveMemberId,
      status,
      comment: comment || null,
    },
    { onConflict: "review_id,respondent_id" },
  );

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/reviews/my-verdicts`);
  return {};
}
