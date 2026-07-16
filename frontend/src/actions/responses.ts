"use server";

import { createSupabaseServer, type SupabaseServerClient } from "@/lib/supabase/server";
import { getAuthUser, getEffectiveMemberId } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import { dropHiddenConditionals } from "@/lib/conditional";
import { mergeSubmittedAnswers } from "@/lib/answer-merge";
import { buildFieldHashMap, mergeFieldHashes } from "@/lib/answer-staleness";
import { syncCodingAssignmentStatus } from "@/lib/coding-sync";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

export interface SaveResponseOpts {
  notes?: string;
  isAutoSave?: boolean;
}

// Response já existente do mesmo respondente para o mesmo documento. `answers`
// e `answer_field_hashes` são lidos porque o save PRESERVA o que a leitura
// descartou (#484) — ver `answersToPersist` em saveResponse.
interface ExistingResponseRow {
  id: string;
  is_partial: boolean | null;
  answers: Record<string, unknown> | null;
  answer_field_hashes: AnswerFieldHashes;
}

// Fetch profile, existing response, and project config in parallel.
// O lookup de existing filtra is_latest: após uma unificação de membros o
// conjunto fundido pode ter respostas antigas (is_latest=false) no mesmo
// documento — .single() sem o filtro erraria com múltiplas linhas.
async function fetchSaveContext(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  effectiveId: string,
) {
  const [{ data: profile }, { data: existing }, { data: project, error: projErr }, { data: doc }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("first_name, last_name")
        .eq("id", effectiveId)
        .single(),
      supabase
        .from("responses")
        .select("id, is_partial, answers, answer_field_hashes")
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("respondent_id", effectiveId)
        .eq("respondent_type", "humano")
        .eq("is_latest", true)
        .maybeSingle<ExistingResponseRow>(),
      supabase
        .from("projects")
        .select(
          "pydantic_hash, pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch, round_strategy, current_round_id, automation_mode",
        )
        .eq("id", projectId)
        .single(),
      supabase
        .from("documents")
        .select("excluded_at")
        .eq("id", documentId)
        .eq("project_id", projectId)
        .maybeSingle(),
    ]);
  return { profile, existing, project, projErr, doc };
}

interface SaveResponseProjectFields {
  pydantic_hash: string | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
  round_strategy: string | null;
  current_round_id: string | null;
}

interface BuildResponsePayloadParams {
  answersToPersist: Record<string, unknown>;
  answerFieldHashes: Record<string, string>;
  project: SaveResponseProjectFields | null | undefined;
  existing: { is_partial: boolean | null } | null | undefined;
  isAutoSave: boolean;
  notes?: string;
}

function buildResponsePayload({
  answersToPersist,
  answerFieldHashes,
  project,
  existing,
  isAutoSave,
  notes,
}: BuildResponsePayloadParams) {
  const justifications = notes ? { _notes: notes } : null;

  const roundIdToPersist =
    project?.round_strategy === "manual" ? (project?.current_round_id ?? null) : null;

  // Para humanos is_partial e mutavel: auto-save grava true (segue como
  // current_pending em classifyDocStatus) e submit explicito grava false.
  // Excecao: auto-save em response ja submetida (is_partial=false) NAO
  // rebaixa o sinal — combinado com o guard que preserva assignment.status
  // = "concluido", esse rebaixamento faria um doc ja concluido reaparecer
  // como pendente em classifyDocStatus. A imutabilidade descrita na migration
  // 20260425000000 vale so para o fluxo LLM.
  const isPartialToWrite = isAutoSave && existing?.is_partial !== false;

  const payload = {
    answers: answersToPersist,
    justifications,
    pydantic_hash: project?.pydantic_hash ?? null,
    answer_field_hashes: answerFieldHashes,
    schema_version_major: project?.schema_version_major ?? 0,
    schema_version_minor: project?.schema_version_minor ?? 1,
    schema_version_patch: project?.schema_version_patch ?? 0,
    version_inferred_from: "live_save",
    round_id: roundIdToPersist,
    is_partial: isPartialToWrite,
    // Marca a codificacao do pesquisador no tempo — alimenta a ordenacao
    // "codificados recentemente" da navegacao da aba Codificar (issue #108).
    updated_at: new Date().toISOString(),
  };

  return payload;
}

interface UpsertResponseRowParams {
  supabase: SupabaseServerClient;
  existing: { id: string } | null | undefined;
  projectId: string;
  documentId: string;
  effectiveId: string;
  respondentName: string;
  payload: Record<string, unknown>;
}

async function upsertResponseRow({
  supabase,
  existing,
  projectId,
  documentId,
  effectiveId,
  respondentName,
  payload,
}: UpsertResponseRowParams): Promise<{ error?: string }> {
  if (existing) {
    const { error } = await supabase.from("responses").update(payload).eq("id", existing.id);
    if (error) return { error: error.message };
    return {};
  }
  const { error } = await supabase.from("responses").insert({
    project_id: projectId,
    document_id: documentId,
    respondent_id: effectiveId,
    respondent_type: "humano",
    respondent_name: respondentName,
    is_latest: true,
    ...payload,
  });
  if (error) return { error: error.message };
  return {};
}

// Auto-save nao revalida o RSC tree — evita re-fetch do servidor a cada
// troca de aba / navegacao entre docs e qualquer flicker residual no
// formulario. Submit explicito (handleSubmit / handleBrowseSubmit) revalida
// normalmente, propagando o efeito para Compare, Reviews e o progresso.
function revalidateAfterSave(projectId: string, isAutoSave: boolean): void {
  if (isAutoSave) return;
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
  revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
  revalidatePath(`/projects/${projectId}/reviews`);
  revalidateTag(`project-${projectId}-progress`, { expire: 60 });
}

export async function saveResponse(
  projectId: string,
  documentId: string,
  answers: Record<string, unknown>,
  opts: SaveResponseOpts = {},
): Promise<{ success: boolean; error?: string }> {
  const { notes, isAutoSave = false } = opts;
  try {
    const user = await getAuthUser();
    if (!user) return { success: false, error: "Não autenticado" };

    // Identidade de trabalho no projeto (spec 002): conta vinculada codifica
    // como o membro canônico — respondent_id, assignments e auto-review usam
    // sempre o id efetivo.
    const effectiveId = await getEffectiveMemberId(projectId);

    const supabase = await createSupabaseServer();

    const { profile, existing, project, projErr, doc } = await fetchSaveContext(
      supabase,
      projectId,
      documentId,
      effectiveId,
    );

    if (projErr) return { success: false, error: projErr.message };

    // Doc já excluído (soft delete) não aceita mais respostas. Pedido de
    // exclusão apenas PENDENTE não bloqueia: é reversível e o dado humano
    // digitado é preservado.
    if (doc?.excluded_at) {
      return {
        success: false,
        error: "Documento removido do escopo do projeto",
      };
    }

    const respondentName =
      [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || user.email;

    const fields = (project?.pydantic_fields as PydanticField[]) || [];

    // Drop values of fields whose visibility condition is not satisfied —
    // prevents orphaned answers from earlier trigger values ending up in the
    // persisted payload. Ponto-fixo compartilhado com o clean de leitura
    // (getDocumentForCoding / code/page.tsx) — ver #252.
    const sanitizedAnswers = dropHiddenConditionals(fields, answers);

    // Persistência preserva o que a leitura descartou por estar fora das opções
    // atuais; sem isto, salvar um campo apaga do banco o valor de outro que o
    // formulário nem chegou a exibir (#484). Os dois conjuntos são distintos de
    // propósito e NÃO devem ser unificados: `sanitizedAnswers` responde "o
    // pesquisador respondeu o formulário atual?" e `answersToPersist` responde
    // "o que sabemos sobre este documento?".
    //
    // Escopo da distinção: ela protege o gate INLINE abaixo
    // (syncCodingAssignmentStatus), que recebe `sanitizedAnswers` e portanto não
    // deixa um valor invisível na tela promover a codificação a concluída. Ela
    // NÃO alcança quem avalia a completude retroativamente relendo do banco
    // (auto-review-backlog, auto-comparison), que só enxerga o conjunto
    // persistido e conta o valor herdado como resposta — ver #492.
    const answersToPersist = dropHiddenConditionals(
      fields,
      mergeSubmittedAnswers(existing?.answers, sanitizedAnswers),
    );

    // Campos cujo valor veio de `existing` sem passar pelo formulário atual.
    // Carimbá-los com o hash de agora os faria passar por respostas ao schema
    // vigente e apagaria o badge "desatualizada" justamente neles — ver
    // mergeFieldHashes.
    const inheritedFieldNames = Object.keys(answersToPersist).filter(
      (name) => !(name in sanitizedAnswers),
    );

    const payload = buildResponsePayload({
      answersToPersist,
      answerFieldHashes: mergeFieldHashes(
        existing?.answer_field_hashes ?? null,
        buildFieldHashMap(fields),
        inheritedFieldNames,
      ),
      project,
      existing,
      isAutoSave,
      notes,
    });

    const { error: upsertErr } = await upsertResponseRow({
      supabase,
      existing,
      projectId,
      documentId,
      effectiveId,
      respondentName,
      payload,
    });
    if (upsertErr) return { success: false, error: upsertErr };

    if (fields.length > 0) {
      const { error: syncErr } = await syncCodingAssignmentStatus(supabase, {
        projectId,
        documentId,
        userId: effectiveId,
        fields,
        sanitizedAnswers,
        isAutoSave,
        automationMode: project?.automation_mode,
      });
      if (syncErr) return { success: false, error: syncErr };
    }

    revalidateAfterSave(projectId, isAutoSave);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}
