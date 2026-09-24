"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, type AuthUser } from "@/lib/auth";
import { errorMessage } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import type { LlmErrorSource } from "@/lib/llm-error-metrics";
import { choosesValue, errorResolutionInputSchema, errorResolutionContextSchema, type ErrorResolutionInput, type ErrorResolutionContext } from "@/lib/error-resolution";

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

// Reabrir uma resolução por (projeto, response) é o mesmo DELETE em duas
// tabelas; devolver a chave é o que distingue "nada reaberto" de sucesso.
async function deleteResolutionByResponse(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  table: "note_resolutions" | "difficulty_resolutions",
  projectId: string,
  responseId: string,
  nothingReopened: string,
): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase
    .from(table)
    .delete()
    .eq("project_id", projectId)
    .eq("response_id", responseId)
    .select("response_id");

  if (error) return { success: false, error: error.message };
  if (!data || data.length === 0) return { success: false, error: nothingReopened };
  return { success: true };
}

// Resolver e reabrir uma dúvida de veredito são o mesmo UPDATE com valores
// opostos em (resolved_at, resolved_by).
async function setDuvidaResolution(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  reviewId: string,
  respondentId: string,
  patch: { resolved_at: string | null; resolved_by: string | null },
  forbidden: string,
): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("verdict_acknowledgments")
    .update(patch)
    .eq("review_id", reviewId)
    .eq("respondent_id", respondentId)
    .select("review_id");

  if (error) return { success: false, error: error.message };
  if (!data || data.length === 0) return { success: false, error: forbidden };
  return { success: true };
}

export async function reopenNote(
  projectId: string,
  responseId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, (_user, supabase) =>
    deleteResolutionByResponse(supabase, "note_resolutions", projectId, responseId,
      "Nada reaberto: sem permissão ou anotação já reaberta"));
}

export async function resolveDuvida(
  projectId: string,
  reviewId: string,
  respondentId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, (user, supabase) =>
    setDuvidaResolution(supabase, reviewId, respondentId,
      { resolved_at: new Date().toISOString(), resolved_by: user.id },
      "Sem permissão para resolver esta dúvida"));
}

export async function reopenDuvida(
  projectId: string,
  reviewId: string,
  respondentId: string,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, (_user, supabase) =>
    setDuvidaResolution(supabase, reviewId, respondentId,
      { resolved_at: null, resolved_by: null },
      "Sem permissão para reabrir esta dúvida"));
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
  return withResolutionAction(projectId, (_user, supabase) =>
    deleteResolutionByResponse(supabase, "difficulty_resolutions", projectId, responseId,
      "Nada reaberto: sem permissão ou dificuldade já reaberta"));
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

type ErrorResolutionIdentity = NonNullable<ErrorResolutionInput["expected"]>;

// A resposta humana do contexto é âncora de invalidação (`responses_hash`), não
// a origem do valor aprovado (#733). Por isso o servidor a escolhe: a que a
// arbitragem escolheu, se ainda é humana `is_latest` da rodada corrente; senão
// a humana `is_latest` mais antiga do documento na rodada. É o mesmo domínio
// que `llm_error_context` aceita, então uma escolha fora dele devolveria NULL.
// Na auto-revisão não há escolha: a RPC só aceita a humana que o `field_reviews`
// registra. Trocar por outra devolveria NULL com a mensagem de "fontes
// mudaram", que manda recarregar uma página que não vai mudar.
async function pickHumanResponse(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  input: { projectId: string; documentId: string; preferredHumanResponseId?: string | null; sourceKind: LlmErrorSource },
): Promise<string | "no-round" | null> {
  const { data: project } = await supabase
    .from("projects").select("current_round_id").eq("id", input.projectId).single();
  const currentRoundId = (project?.current_round_id as string | null) ?? null;
  if (!currentRoundId) return "no-round";
  const { data: humans } = await supabase
    .from("responses").select("id")
    .eq("project_id", input.projectId).eq("document_id", input.documentId)
    .eq("respondent_type", "humano").eq("is_latest", true).eq("round_id", currentRoundId)
    .order("created_at", { ascending: true }).limit(50);
  const ids = (humans ?? []).map((r) => r.id as string);
  if (input.preferredHumanResponseId && ids.includes(input.preferredHumanResponseId)) return input.preferredHumanResponseId;
  return input.sourceKind === "auto_revisao" ? null : ids[0] ?? null;
}

export async function prepareErrorResolution(input: {
  projectId: string; documentId: string; fieldName: string;
  llmResponseId: string; preferredHumanResponseId?: string | null; sourceKind: LlmErrorSource; sourceId: string;
}): Promise<{ context?: ErrorResolutionContext; error?: string }> {
  try {
    if (!await getAuthUser()) return { error: "Não autenticado" };
    const supabase = await createSupabaseServer();
    const humanResponseId = await pickHumanResponse(supabase, input);
    if (humanResponseId === "no-round") return { error: "O projeto está sem rodada corrente. Abra uma rodada antes de decidir." };
    if (!humanResponseId) {
      return { error: input.sourceKind === "auto_revisao"
        ? "A resposta humana desta auto-revisão não está mais ativa na rodada. Refaça a auto-revisão antes de decidir."
        : "Nenhuma resposta humana ativa nesta rodada. Refaça a revisão antes de decidir." };
    }
    const { data, error } = await supabase.rpc("llm_error_context", {
      p_project_id: input.projectId, p_document_id: input.documentId, p_field_name: input.fieldName,
      p_llm_response_id: input.llmResponseId, p_human_response_id: humanResponseId,
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
  input: ErrorResolutionInput,
): Promise<{ success: boolean; error?: string }> {
  return withResolutionAction(projectId, async (_user, supabase) => {
    const parsed = errorResolutionInputSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: "Decisão ou contexto inválido." };
    const { decision, context, expected, note, value } = parsed.data;
    const identity = expected ?? { id: null, resolved_at: null };
    const { data, error } = await supabase.rpc("set_error_resolution", {
      p_project_id: projectId, p_document_id: documentId, p_field_name: fieldName,
      p_decision: decision, p_expected_context: context,
      p_expected_id: identity.id,
      p_expected_resolved_at: identity.resolved_at, p_note: note ?? null,
      // A RPC valida o valor contra a definição do campo nas decisões que o levam.
      p_value: choosesValue(decision) ? (value ?? null) : null,
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
