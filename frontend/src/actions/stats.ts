"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, type AuthUser } from "@/lib/auth";
import { errorMessage } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import { errorDecisionSchema, errorResolutionContextSchema, type ErrorDecision, type ErrorResolutionContext } from "@/lib/error-resolution";

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

export interface ErrorResolutionIdentity {
  id: string;
  resolved_at: string;
}

export async function prepareErrorResolution(input: {
  projectId: string; documentId: string; fieldName: string;
  llmResponseId: string; humanResponseId: string; sourceKind: string; sourceId: string;
}): Promise<{ context?: ErrorResolutionContext; error?: string }> {
  try {
    if (!await getAuthUser()) return { error: "Não autenticado" };
    const supabase = await createSupabaseServer();
    const { data, error } = await supabase.rpc("llm_error_context", {
      p_project_id: input.projectId, p_document_id: input.documentId, p_field_name: input.fieldName,
      p_llm_response_id: input.llmResponseId, p_human_response_id: input.humanResponseId,
      p_source_kind: input.sourceKind, p_source_id: input.sourceId,
    });
    if (error) return { error: error.message };
    const parsed = errorResolutionContextSchema.safeParse(data);
    return parsed.success ? { context: parsed.data } : { error: "As fontes mudaram ou não estão disponíveis. Recarregue a página." };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

function revalidateErrorResults(projectId: string) {
  revalidatePath(`/projects/${projectId}/reviews/llm-insights`);
  revalidatePath(`/projects/${projectId}/reviews/gabarito`);
  revalidatePath(`/projects/${projectId}/config/documents`);
}

export async function resolveError(
  projectId: string, documentId: string, fieldName: string,
  input: { decision: ErrorDecision; context: ErrorResolutionContext; expected: ErrorResolutionIdentity | null; note?: string },
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (_user, supabase) => {
    const decision = errorDecisionSchema.safeParse(input?.decision);
    const context = errorResolutionContextSchema.safeParse(input?.context);
    if (!decision.success || !context.success) return { success: false, error: "Decisão ou contexto inválido." };
    const { data, error } = await supabase.rpc("set_error_resolution", {
      p_project_id: projectId, p_document_id: documentId, p_field_name: fieldName,
      p_decision: decision.data, p_expected_context: context.data,
      p_expected_id: input.expected?.id ?? null,
      p_expected_resolved_at: input.expected?.resolved_at ?? null, p_note: input.note ?? null,
    });
    if (error) return { success: false, error: error.message };
    if (!data?.id) return { success: false, error: "O banco não confirmou a gravação." };
    revalidateErrorResults(projectId);
    return { success: true };
  });
}

export async function reopenError(
  projectId: string, documentId: string, fieldName: string,
  expected: ErrorResolutionIdentity,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (_user, supabase) => {
    const { data, error } = await supabase.rpc("set_error_resolution", {
      p_project_id: projectId, p_document_id: documentId, p_field_name: fieldName,
      p_decision: null, p_expected_context: null,
      p_expected_id: expected.id, p_expected_resolved_at: expected.resolved_at, p_note: null,
    });
    if (error) return { success: false, error: error.message };
    if (data?.reopened !== true) return { success: false, error: "O banco não confirmou a reabertura." };
    revalidateErrorResults(projectId);
    return { success: true };
  });
}
