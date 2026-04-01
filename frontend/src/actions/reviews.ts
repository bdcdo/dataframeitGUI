"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";

export interface ResponseSnapshotEntry {
  id: string;
  respondent_name: string;
  respondent_type: "humano" | "llm";
  answer: unknown;
  justification?: string;
}

export async function submitVerdict(
  projectId: string,
  documentId: string,
  fieldName: string,
  verdict: string,
  chosenResponseId?: string,
  comment?: string,
  responseSnapshot?: ResponseSnapshotEntry[],
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
      response_snapshot: responseSnapshot ?? null,
    },
    {
      onConflict: "project_id,document_id,field_name,reviewer_id",
    }
  );

  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
}
