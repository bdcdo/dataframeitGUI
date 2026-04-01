"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";

export async function submitVerdict(
  projectId: string,
  documentId: string,
  fieldName: string,
  verdict: string,
  chosenResponseId?: string,
  comment?: string
) {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();

  const { error } = await supabase.from("reviews").upsert(
    {
      project_id: projectId,
      document_id: documentId,
      field_name: fieldName,
      reviewer_id: user.id,
      verdict,
      chosen_response_id: chosenResponseId || null,
      comment: comment || null,
    },
    {
      onConflict: "project_id,document_id,field_name,reviewer_id",
    }
  );

  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}/compare`);
}
