"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";

export async function resolveReviewComment(
  reviewId: string,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { error } = await supabase
      .from("reviews")
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: user.id,
      })
      .eq("id", reviewId);

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/reviews`);
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
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { error } = await supabase
      .from("reviews")
      .update({
        resolved_at: null,
        resolved_by: null,
      })
      .eq("id", reviewId);

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/reviews`);
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
    const user = await getAuthUser();
    if (!user) return { error: "Não autenticado" };

    const supabase = await createSupabaseServer();

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
    revalidatePath(`/projects/${projectId}/reviews`);
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
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { error } = await supabase.from("difficulty_resolutions").insert({
      project_id: projectId,
      response_id: responseId,
      document_id: documentId,
      resolved_by: user.id,
      note: note || null,
    });

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/reviews`);
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
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { error } = await supabase
      .from("difficulty_resolutions")
      .delete()
      .eq("project_id", projectId)
      .eq("response_id", responseId);

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/reviews`);
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
    const user = await getAuthUser();
    if (!user) return { error: "Não autenticado" };

    const supabase = await createSupabaseServer();

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
    revalidatePath(`/projects/${projectId}/reviews`);
    return { id: data.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export interface GabaritoRespondentAnswer {
  respondentName: string;
  respondentType: "humano" | "llm";
  answer: unknown;
  isChosen: boolean;
}

export async function fetchGabaritoForComment(
  projectId: string,
  documentId: string,
  fieldName: string,
  chosenResponseId: string | null,
): Promise<{ answers: GabaritoRespondentAnswer[]; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { answers: [], error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { data: responses } = await supabase
      .from("responses")
      .select("id, respondent_name, respondent_type, answers")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .or("is_current.eq.true,respondent_type.eq.humano");

    if (!responses) return { answers: [] };

    const result: GabaritoRespondentAnswer[] = responses.map((r) => ({
      respondentName: r.respondent_name || "Anônimo",
      respondentType: r.respondent_type as "humano" | "llm",
      answer: (r.answers as Record<string, unknown>)?.[fieldName] ?? null,
      isChosen: r.id === chosenResponseId,
    }));

    return { answers: result };
  } catch (e) {
    return { answers: [], error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function resolveError(
  projectId: string,
  documentId: string,
  fieldName: string,
  note?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { error } = await supabase.from("error_resolutions").insert({
      project_id: projectId,
      document_id: documentId,
      field_name: fieldName,
      resolved_by: user.id,
      note: note || null,
    });

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/reviews`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function reopenError(
  projectId: string,
  documentId: string,
  fieldName: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { error } = await supabase
      .from("error_resolutions")
      .delete()
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("field_name", fieldName);

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/reviews`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function createDiscussionFromError(
  projectId: string,
  documentId: string,
  fieldName: string,
  llmAnswer: string,
  chosenVerdict: string,
): Promise<{ id?: string; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { data: doc } = await supabase
      .from("documents")
      .select("title, external_id")
      .eq("id", documentId)
      .single();

    const docLabel = doc?.title || doc?.external_id || documentId;
    const title = `[Erro LLM] ${docLabel} — ${fieldName}`;
    const body = `**Documento:** ${docLabel}\n**Campo:** ${fieldName}\n**LLM respondeu:** ${llmAnswer}\n**Escolhido:** ${chosenVerdict}`;

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
    revalidatePath(`/projects/${projectId}/reviews`);
    return { id: data.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}
