"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, getEffectiveMemberId } from "@/lib/auth";
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
    actorId: string,
    supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  ) => Promise<{ success: boolean; error?: string }>,
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };
    const [supabase, actorId] = await Promise.all([
      createSupabaseServer(),
      getEffectiveMemberId(projectId),
    ]);
    const result = await action(actorId, supabase);
    if (result.success) revalidatePath(`/projects/${projectId}/reviews`);
    return result;
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro desconhecido" };
  }
}

async function setReviewResolution(
  reviewId: string,
  projectId: string,
  resolved: boolean,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!(await getAuthUser())) {
      return { success: false, error: "Não autenticado" };
    }
    const supabase = await createSupabaseServer();
    const { error } = await supabase.rpc("set_review_resolution", {
      p_project_id: projectId,
      p_review_id: reviewId,
      p_resolved: resolved,
    });

    if (error) return { success: false, error: error.message };
    revalidatePath(`/projects/${projectId}/reviews`);
    return { success: true };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro desconhecido" };
  }
}

function affectedRowResult(
  data: unknown[] | null,
  error: { message: string } | null,
  emptyMessage: string,
): { success: boolean; error?: string } {
  if (error) return { success: false, error: error.message };
  return data && data.length > 0
    ? { success: true }
    : { success: false, error: emptyMessage };
}

async function setDuvidaResolution(
  reviewId: string,
  respondentId: string,
  resolvedBy: string | null,
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("verdict_acknowledgments")
    .update({
      resolved_at: resolvedBy ? new Date().toISOString() : null,
      resolved_by: resolvedBy,
    })
    .eq("review_id", reviewId)
    .eq("respondent_id", respondentId)
    .select("review_id");

  return affectedRowResult(
    data,
    error,
    resolvedBy
      ? "Sem permissão para resolver esta dúvida"
      : "Sem permissão para reabrir esta dúvida",
  );
}

export async function resolveReviewComment(
  reviewId: string,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  return setReviewResolution(reviewId, projectId, true);
}

export async function reopenReviewComment(
  reviewId: string,
  projectId: string,
): Promise<{ success: boolean; error?: string }> {
  return setReviewResolution(reviewId, projectId, false);
}

export async function resolveNote(
  projectId: string,
  responseId: string,
  note?: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (actorId, supabase) => {
    const { error } = await supabase.from("note_resolutions").insert({
      project_id: projectId,
      response_id: responseId,
      resolved_by: actorId,
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

    return affectedRowResult(
      data,
      error,
      "Nada reaberto: sem permissão ou anotação já reaberta",
    );
  });
}

export async function resolveDuvida(
  projectId: string,
  reviewId: string,
  respondentId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (actorId, supabase) => {
    return setDuvidaResolution(reviewId, respondentId, actorId, supabase);
  });
}

export async function reopenDuvida(
  projectId: string,
  reviewId: string,
  respondentId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (_user, supabase) => {
    return setDuvidaResolution(reviewId, respondentId, null, supabase);
  });
}

export async function resolveDifficulty(
  projectId: string,
  responseId: string,
  documentId: string,
  note?: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (actorId, supabase) => {
    const { error } = await supabase.from("difficulty_resolutions").insert({
      project_id: projectId,
      response_id: responseId,
      document_id: documentId,
      resolved_by: actorId,
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

    return affectedRowResult(
      data,
      error,
      "Nada reaberto: sem permissão ou dificuldade já reaberta",
    );
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
  return withResolutionAction(projectId, async (actorId, supabase) => {
    const { error } = await supabase.from("error_resolutions").insert({
      project_id: projectId,
      document_id: documentId,
      field_name: fieldName,
      resolved_by: actorId,
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

    return affectedRowResult(
      data,
      error,
      "Nada reaberto: sem permissão ou erro já reaberto",
    );
  });
}
