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

export async function resolveNote(
  projectId: string,
  responseId: string,
  note?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { error } = await supabase.from("note_resolutions").insert({
      project_id: projectId,
      response_id: responseId,
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

export async function reopenNote(
  projectId: string,
  responseId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { error } = await supabase
      .from("note_resolutions")
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

export async function resolveDuvida(
  projectId: string,
  reviewId: string,
  respondentId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { data, error } = await supabase
      .from("verdict_acknowledgments")
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: user.id,
      })
      .eq("review_id", reviewId)
      .eq("respondent_id", respondentId)
      .select("review_id");

    if (error) return { success: false, error: error.message };
    if (!data || data.length === 0)
      return { success: false, error: "Sem permissão para resolver esta dúvida" };

    revalidatePath(`/projects/${projectId}/reviews`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function reopenDuvida(
  projectId: string,
  reviewId: string,
  respondentId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const supabase = await createSupabaseServer();

    const { data, error } = await supabase
      .from("verdict_acknowledgments")
      .update({
        resolved_at: null,
        resolved_by: null,
      })
      .eq("review_id", reviewId)
      .eq("respondent_id", respondentId)
      .select("review_id");

    if (error) return { success: false, error: error.message };
    if (!data || data.length === 0)
      return { success: false, error: "Sem permissão para reabrir esta dúvida" };

    revalidatePath(`/projects/${projectId}/reviews`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
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
