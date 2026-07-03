"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, type AuthUser } from "@/lib/auth";
import { errorMessage } from "@/lib/utils";
import { revalidatePath } from "next/cache";

// As 10 funções resolve/reopen abaixo (5 pares, sobre 5 tabelas) compartilhavam
// o mesmo esqueleto: auth → supabase → mutação específica → revalidatePath só
// no sucesso → catch genérico. withResolutionAction absorve esse esqueleto sem
// tocar a query em si — cada callback monta seu próprio `.from(tabela)...`
// com tipagem completa do client Supabase, sem genéricos por string de tabela.
async function withResolutionAction(
  projectId: string,
  action: (
    user: AuthUser,
    supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  ) => Promise<{ success: boolean; error?: string }>,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };
    const supabase = await createSupabaseServer();
    const result = await action(user, supabase);
    if (result.success) revalidatePath(`/projects/${projectId}/reviews`);
    return result;
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro desconhecido" };
  }
}

export async function resolveReviewComment(
  reviewId: string,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (user, supabase) => {
    const { data, error } = await supabase
      .from("reviews")
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: user.id,
      })
      .eq("id", reviewId)
      .select("id");

    if (error) return { success: false, error: error.message };
    if (!data || data.length === 0)
      return { success: false, error: "Sem permissão para resolver este comentário" };
    return { success: true };
  });
}

export async function reopenReviewComment(
  reviewId: string,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (_user, supabase) => {
    const { data, error } = await supabase
      .from("reviews")
      .update({
        resolved_at: null,
        resolved_by: null,
      })
      .eq("id", reviewId)
      .select("id");

    if (error) return { success: false, error: error.message };
    if (!data || data.length === 0)
      return { success: false, error: "Sem permissão para reabrir este comentário" };
    return { success: true };
  });
}

export async function resolveNote(
  projectId: string,
  responseId: string,
  note?: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (user, supabase) => {
    const { error } = await supabase.from("note_resolutions").insert({
      project_id: projectId,
      response_id: responseId,
      resolved_by: user.id,
      note: note || null,
    });

    if (error) return { success: false, error: error.message };
    return { success: true };
  });
}

export async function reopenNote(
  projectId: string,
  responseId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (_user, supabase) => {
    const { data, error } = await supabase
      .from("note_resolutions")
      .delete()
      .eq("project_id", projectId)
      .eq("response_id", responseId)
      .select("response_id");

    if (error) return { success: false, error: error.message };
    if (!data || data.length === 0)
      return { success: false, error: "Nada reaberto: sem permissão ou anotação já reaberta" };
    return { success: true };
  });
}

export async function resolveDuvida(
  projectId: string,
  reviewId: string,
  respondentId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (user, supabase) => {
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
    return { success: true };
  });
}

export async function reopenDuvida(
  projectId: string,
  reviewId: string,
  respondentId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (_user, supabase) => {
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
    return { success: true };
  });
}

export async function resolveDifficulty(
  projectId: string,
  responseId: string,
  documentId: string,
  note?: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (user, supabase) => {
    const { error } = await supabase.from("difficulty_resolutions").insert({
      project_id: projectId,
      response_id: responseId,
      document_id: documentId,
      resolved_by: user.id,
      note: note || null,
    });

    if (error) return { success: false, error: error.message };
    return { success: true };
  });
}

export async function reopenDifficulty(
  projectId: string,
  responseId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (_user, supabase) => {
    const { data, error } = await supabase
      .from("difficulty_resolutions")
      .delete()
      .eq("project_id", projectId)
      .eq("response_id", responseId)
      .select("response_id");

    if (error) return { success: false, error: error.message };
    if (!data || data.length === 0)
      return { success: false, error: "Nada reaberto: sem permissão ou dificuldade já reaberta" };
    return { success: true };
  });
}

export interface GabaritoRespondentAnswer {
  /** id da resposta — key estável de render (nomes de respondente colidem). */
  id: string;
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
      // Só respostas ativas: humanas rebaixadas (is_latest=false) ou LLM antigo
      // não devem aparecer no gabarito do comentário.
      .eq("is_latest", true);

    if (!responses) return { answers: [] };

    const result: GabaritoRespondentAnswer[] = responses.map((r) => ({
      id: r.id,
      respondentName: r.respondent_name || "Anônimo",
      respondentType: r.respondent_type as "humano" | "llm",
      answer: (r.answers as Record<string, unknown>)?.[fieldName] ?? null,
      isChosen: r.id === chosenResponseId,
    }));

    return { answers: result };
  } catch (e) {
    return { answers: [], error: errorMessage(e) || "Erro desconhecido" };
  }
}

export async function resolveError(
  projectId: string,
  documentId: string,
  fieldName: string,
  note?: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (user, supabase) => {
    const { error } = await supabase.from("error_resolutions").insert({
      project_id: projectId,
      document_id: documentId,
      field_name: fieldName,
      resolved_by: user.id,
      note: note || null,
    });

    if (error) return { success: false, error: error.message };
    return { success: true };
  });
}

export async function reopenError(
  projectId: string,
  documentId: string,
  fieldName: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (_user, supabase) => {
    const { data, error } = await supabase
      .from("error_resolutions")
      .delete()
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("field_name", fieldName)
      .select("document_id");

    if (error) return { success: false, error: error.message };
    if (!data || data.length === 0)
      return { success: false, error: "Nada reaberto: sem permissão ou erro já reaberto" };
    return { success: true };
  });
}
