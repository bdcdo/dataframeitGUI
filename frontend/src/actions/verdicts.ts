"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";

export async function acknowledgeVerdict(
  reviewId: string,
  projectId: string,
  status: "accepted" | "questioned",
  comment?: string,
): Promise<{ error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const { error } = await supabase.from("verdict_acknowledgments").upsert(
    {
      review_id: reviewId,
      respondent_id: user.id,
      status,
      comment: comment || null,
    },
    { onConflict: "review_id,respondent_id" },
  );

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/reviews/my-verdicts`);
  return {};
}
