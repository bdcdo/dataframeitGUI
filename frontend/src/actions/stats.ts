"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function resolveReviewComment(
  reviewId: string,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const { error } = await supabase
      .from("reviews")
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: user.id,
      })
      .eq("id", reviewId);

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/stats`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function reopenReviewComment(
  reviewId: string,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const { error } = await supabase
      .from("reviews")
      .update({
        resolved_at: null,
        resolved_by: null,
      })
      .eq("id", reviewId);

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/stats`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function createDiscussionFromComment(
  projectId: string,
  reviewId: string,
): Promise<{ id?: string; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { error: "Não autenticado" };

    const { data: review } = await supabase
      .from("reviews")
      .select("document_id, field_name, verdict, comment")
      .eq("id", reviewId)
      .single();

    if (!review) return { error: "Review não encontrada" };

    const { data: doc } = await supabase
      .from("documents")
      .select("title, external_id")
      .eq("id", review.document_id)
      .single();

    const docLabel = doc?.title || doc?.external_id || review.document_id;
    const title = `[Comentário] ${docLabel} — ${review.field_name}`;
    const body = `**Documento:** ${docLabel}\n**Campo:** ${review.field_name}\n**Veredito:** ${review.verdict}\n\n> ${review.comment}`;

    const { data, error } = await supabase
      .from("discussions")
      .insert({
        project_id: projectId,
        title,
        body,
        document_id: review.document_id,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (error) return { error: error.message };

    revalidatePath(`/projects/${projectId}/discussions`);
    revalidatePath(`/projects/${projectId}/stats`);
    return { id: data.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function resolveDifficulty(
  projectId: string,
  responseId: string,
  documentId: string,
  note?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const { error } = await supabase.from("difficulty_resolutions").insert({
      project_id: projectId,
      response_id: responseId,
      document_id: documentId,
      resolved_by: user.id,
      note: note || null,
    });

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/stats`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function reopenDifficulty(
  projectId: string,
  responseId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const { error } = await supabase
      .from("difficulty_resolutions")
      .delete()
      .eq("project_id", projectId)
      .eq("response_id", responseId);

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/stats`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function createDiscussionFromDifficulty(
  projectId: string,
  responseId: string,
  documentId: string,
): Promise<{ id?: string; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { error: "Não autenticado" };

    const [{ data: response }, { data: doc }] = await Promise.all([
      supabase
        .from("responses")
        .select("answers, respondent_name")
        .eq("id", responseId)
        .single(),
      supabase
        .from("documents")
        .select("title, external_id")
        .eq("id", documentId)
        .single(),
    ]);

    const ambiguidades =
      (response?.answers as Record<string, unknown>)?.llm_ambiguidades || "";
    const docLabel = doc?.title || doc?.external_id || documentId;
    const model = response?.respondent_name || "LLM";
    const title = `[Dificuldade LLM] ${docLabel}`;
    const body = `**Documento:** ${docLabel}\n**Modelo:** ${model}\n\n> ${ambiguidades}`;

    const { data, error } = await supabase
      .from("discussions")
      .insert({
        project_id: projectId,
        title,
        body,
        document_id: documentId,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (error) return { error: error.message };

    revalidatePath(`/projects/${projectId}/discussions`);
    revalidatePath(`/projects/${projectId}/stats`);
    return { id: data.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}
