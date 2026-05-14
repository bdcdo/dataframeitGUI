"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { syncCompareAssignment } from "@/lib/compare-sync";

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

  // Veredito "ambiguo" vira comentário automático na aba Comentários. O
  // invariante mantido aqui: existe um project_comments kind='ambiguity' por
  // (projeto, documento, campo) se e somente se há ao menos um review com
  // verdict='ambiguo' para esse campo. O upsert acima já gravou o veredito
  // atual, então as queries abaixo enxergam o estado pós-mudança.
  if (verdict === "ambiguo") {
    // Idempotente: um único comentário por (projeto, documento, campo) — o
    // índice único parcial idx_pc_ambiguity_unique é o backstop contra corrida.
    const { data: existingAmbiguity } = await supabase
      .from("project_comments")
      .select("id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("field_name", fieldName)
      .eq("kind", "ambiguity")
      .maybeSingle();

    if (!existingAmbiguity) {
      const { error: commentError } = await supabase
        .from("project_comments")
        .insert({
          project_id: projectId,
          document_id: documentId,
          field_name: fieldName,
          author_id: user.id,
          body: comment?.trim()
            ? `Campo marcado como ambíguo na revisão (aba Comparar): ${comment.trim()}`
            : "Campo marcado como ambíguo na revisão (aba Comparar).",
          kind: "ambiguity",
        });

      // Ignora violação do índice único (revisor concorrente marcou o mesmo
      // campo+doc) — o comentário já existe, que é o estado desejado.
      if (commentError && commentError.code !== "23505") {
        throw new Error(commentError.message);
      }
    }
  } else {
    // Veredito deixou de ser ambíguo. Se nenhum outro revisor ainda marca
    // este campo como ambíguo, remove o comentário automático para não deixar
    // pendência órfã na aba Comentários.
    const { data: stillAmbiguous } = await supabase
      .from("reviews")
      .select("id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("field_name", fieldName)
      .eq("verdict", "ambiguo")
      .limit(1);

    if (!stillAmbiguous || stillAmbiguous.length === 0) {
      const { error: deleteError } = await supabase
        .from("project_comments")
        .delete()
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("field_name", fieldName)
        .eq("kind", "ambiguity");

      if (deleteError) throw new Error(deleteError.message);
    }
  }

  revalidatePath(`/projects/${projectId}/reviews/comments`);

  await syncCompareAssignment(supabase, projectId, documentId, user.id);

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
}

// Para docs sem divergência (revisor decide fechar manualmente).
export async function markCompareDocReviewed(
  projectId: string,
  documentId: string,
) {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();

  const { error } = await supabase
    .from("assignments")
    .update({ status: "concluido", completed_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", user.id)
    .eq("type", "comparacao");

  if (error) throw new Error(error.message);

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
}
