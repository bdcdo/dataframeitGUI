"use server";

import { createSupabaseServer, type SupabaseServerClient } from "@/lib/supabase/server";
import { resolveProjectMemberActor } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import { buildPersistedResponseSnapshot } from "@/lib/response-snapshot";
import { isCodingComplete, missingRequiredHumanFields } from "@/lib/coding-completeness";
import { syncCodingAssignmentStatus } from "@/lib/coding-sync";
import { deriveProjectVersionContext } from "@/lib/compare-version";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

export interface SaveResponseOpts {
  notes?: string;
  isAutoSave?: boolean;
}

export type SaveResponseResult =
  // `missingRequired`: obrigatórias ainda em branco no conjunto GRAVADO (0 =
  // codificação completa). É a mesma contagem que decide `is_partial`, e vai ao
  // cliente para o feedback distinguir "salvo" de "concluído" (#519). Opcional
  // porque só `saveResponse` a computa — o adapter `saveCodingResponse` a repassa
  // mas seu ramo de erro de transporte não a tem, e `notifySaved` lê `undefined`
  // como "completo". União (não interface achatada) para manter irrepresentável
  // o estado `{ success: true, error }`.
  | { success: true; missingRequired?: number }
  | { success: false; error: string };

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
  fields: PydanticField[];
  answersToPersist: Record<string, unknown>;
  answerFieldHashes: Exclude<AnswerFieldHashes, null>;
  stampsCurrentSchema: boolean;
  project: SaveResponseProjectFields | null | undefined;
  existing: { is_partial: boolean | null } | null | undefined;
  isAutoSave: boolean;
  notes?: string;
}

// Decide as colunas de versão (`pydantic_hash`, `schema_version_*`,
// `version_inferred_from`) a gravar. Devolve `{}` — omitindo-as do UPDATE, o que
// PRESERVA os valores já na linha — quando este save não gravou proveniência do
// schema de hoje no mapa per-campo (`!stampsCurrentSchema`). Só vale para UPDATE:
// numa codificação nova (`!existing`) não há proveniência anterior a preservar.
//
// `stampsCurrentSchema` (de `buildPersistedResponseSnapshot`) é o sinal ÚNICO da
// decisão, o mesmo que governa o mapa per-campo — as colunas ficam simétricas ao
// mapa por construção, e não por dois gatilhos mantidos em acordo. Ele é falso, e
// as colunas são preservadas, em dois casos que antes tinham tratamento separado:
//
// 1. STALENESS (legacy, #520/#528/#548). Enquanto a response conserva o sentinela
//    legacy (`answer_field_hashes` vazio), `isFieldStale` cai no fallback do
//    schema INTEIRO e compara `pydantic_hash`. Promovê-lo aqui tornaria o fallback
//    permissivo — a codificação antiga seria lida como feita contra o schema de
//    hoje e nada apareceria stale, reintroduzindo o falso "(vazio)" divergente de
//    answer-staleness.ts. O sentinela só desliga (e `stampsCurrentSchema` fica
//    true) quando um submit explícito RECODIFICA a legacy por completo contra o
//    schema atual (#548) — aí o staleness ser permissivo é o correto, porque tudo
//    foi de fato recodificado.
//
// 2. SEMÂNTICA DE VERSÃO (#529). Numa response não-legacy sem revisão real de
//    valor (auto-save/toque por navegação, ou re-confirmar o mesmo valor), nenhum
//    campo ganha o hash de hoje: os valores seguem da época anterior e o mapa
//    per-campo (#528) já os conserva. Promover só as colunas deixaria a linha
//    assimétrica — hashes de época × versão de hoje — e a faria contar como da
//    versão corrente no gate `latest_major` da Comparação sem revisão alguma.
//
// Custo assumido (#548): preservar prende a linha fora do gate `latest_major` até
// que ela seja de fato recodificada. É o comportamento desejado — uma codificação
// não revisada sob o novo schema não deve contar como da versão nova. A raiz é
// `pydantic_hash` servir a dois consumidores opostos: o staleness quer o hash da
// época, o gate de versão quer o de hoje; os dois só coincidem na recodificação
// completa, e é exatamente aí que `stampsCurrentSchema` vira true.
function resolveSchemaProvenance({
  project,
  stampsCurrentSchema,
  existing,
}: Pick<BuildResponsePayloadParams, "project" | "stampsCurrentSchema" | "existing">) {
  if (!!existing && !stampsCurrentSchema) return {};
  // O fallback {major 0, minor 1, patch 0} é canônico e vive uma única vez em
  // `deriveProjectVersionContext` — reusá-lo evita a duplicação que o cabeçalho
  // de compare-version.ts sinaliza como load-bearing (uma cópia "corrigida" para
  // minor 0 aqui dessincronizaria a fila/fecho da Comparação). O `ctx.pydanticHash`
  // do MESMO helper é `pydantic_hash ?? null`, então hash e versão vêm de uma
  // fonte única — não re-derivar o hash à parte.
  const { version, ctx } = deriveProjectVersionContext(project ?? {});
  return {
    pydantic_hash: ctx.pydanticHash,
    schema_version_major: version.major,
    schema_version_minor: version.minor,
    schema_version_patch: version.patch,
    version_inferred_from: "live_save",
  };
}

function buildResponsePayload({
  fields,
  answersToPersist,
  answerFieldHashes,
  stampsCurrentSchema,
  project,
  existing,
  isAutoSave,
  notes,
}: BuildResponsePayloadParams) {
  const justifications = notes ? { _notes: notes } : null;

  const roundIdToPersist =
    project?.round_strategy === "manual" ? (project?.current_round_id ?? null) : null;

  // Para humanos is_partial descreve O QUE FOI GRAVADO, não por qual canal a
  // escrita chegou: uma resposta só deixa de ser parcial quando o conjunto
  // gravado satisfaz a régua de completude E o pesquisador já enviou (submit
  // explícito). Enquanto o sinal era função apenas do canal
  // (`isAutoSave && existing?.is_partial !== false`), um auto-save herdava o
  // `false` de um submit anterior e podia carimbar "submetida" um conjunto que
  // já não estava completo — o estado que fazia o documento voltar à fila com
  // aparência de concluído (#519).
  //
  // Staleness-aware de propósito: avaliar contra o carimbo per-campo da própria
  // resposta (`answerFieldHashes`) impede que um campo obrigatório criado depois
  // rebaixe uma codificação que estava completa quando foi feita. O auto-save
  // continua sem promover nada por conta própria — quem nunca enviou segue
  // parcial mesmo com tudo preenchido; combinado com o guard que preserva
  // assignment.status = "concluido" em coding-sync, um auto-save posterior a um
  // submit também não rebaixa um doc já concluído (salvo se o conjunto encolheu e
  // deixou de estar completo). A imutabilidade descrita na migration
  // 20260425000000 vale so para o fluxo LLM.
  const submittedBefore = existing?.is_partial === false;
  const isPartialToWrite =
    !isCodingComplete(fields, answersToPersist, answerFieldHashes) ||
    (isAutoSave && !submittedBefore);

  const payload = {
    answers: answersToPersist,
    justifications,
    answer_field_hashes: answerFieldHashes,
    ...resolveSchemaProvenance({ project, stampsCurrentSchema, existing }),
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
): Promise<SaveResponseResult> {
  const { notes, isAutoSave = false } = opts;

  try {
    const actor = await resolveProjectMemberActor(projectId);
    if (!actor.ok) return { success: false, error: actor.error };
    const { user, memberUserId: effectiveId } = actor;

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

    // O formulário devolve um snapshot sanitizado, não um patch. A reconciliação
    // compara esse snapshot com a projeção que foi apresentada e preserva o
    // valor bruto + sua proveniência quando o campo não mudou (#484).
    const snapshot = buildPersistedResponseSnapshot({
      fields,
      existing: existing
        ? { answers: existing.answers, hashes: existing.answer_field_hashes }
        : null,
      rawSubmittedAnswers: answers,
      // Só um submit explícito atesta a codificação inteira; auto-save não pode
      // promover uma response legacy à versão corrente (#548).
      promoteLegacyIfComplete: !isAutoSave,
    });

    const payload = buildResponsePayload({
      fields,
      answersToPersist: snapshot.persistedAnswers,
      answerFieldHashes: snapshot.answerFieldHashes,
      stampsCurrentSchema: snapshot.stampsCurrentSchema,
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
        sanitizedAnswers: snapshot.submittedAnswers,
        isAutoSave,
        automationMode: project?.automation_mode,
        hadCompletedResponse: existing?.is_partial === false,
      });
      if (syncErr) return { success: false, error: syncErr };
    }

    revalidateAfterSave(projectId, isAutoSave);
    // Contagem no conjunto GRAVADO (`snapshot.persistedAnswers`), com o mesmo
    // carimbo staleness-aware que decidiu `is_partial` — não no que a tela
    // mostrava. Se o schema mudou desde o carregamento do formulário, é ela que
    // impede o feedback de sucesso de anunciar uma conclusão que não houve (#519).
    return {
      success: true,
      missingRequired: missingRequiredHumanFields(
        fields,
        snapshot.persistedAnswers,
        snapshot.answerFieldHashes,
      ).length,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "Erro desconhecido",
    };
  }
}
