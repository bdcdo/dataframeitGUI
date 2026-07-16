"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { requireCoordinator, resolveProjectMemberActor } from "@/lib/auth";
import { buildLoadMap } from "@/lib/load-balancing";
import { errorMessage } from "@/lib/utils";
import { canonicalPair } from "@/lib/equivalence";
import { buildEquivalenceMap, type EquivalenceRow } from "@/lib/compare-queue";
import {
  computeBacklogRows,
  compositeKeySet,
  diffReviewsToRemove,
  type ExistingFieldReviewRow,
  type HumanResponseRow,
  type LlmResponseRow,
} from "@/lib/auto-review-backlog";
import { resolveBlindVerdict } from "@/lib/arbitration-order";
import { verdictRequiresJustification } from "@/lib/auto-review-decided";
import { formatAnswerTechnical } from "@/lib/format-answer";
import { syncAutoRevisaoAssignmentStatus } from "@/lib/auto-revisao-sync";
import { syncArbitragemAssignmentStatus } from "@/lib/arbitragem-sync";
import { revalidatePath } from "next/cache";
import type {
  PydanticField,
  SelfVerdict,
  ArbitrationVerdict,
} from "@/lib/types";

export interface SelfVerdictInput {
  fieldName: string;
  verdict: SelfVerdict;
  // Obrigatoria quando verdict='contesta_llm' ou 'ambiguo'. Em contesta_llm o
  // pesquisador registra por que acha que sua resposta esta correta (exibida ao
  // arbitro na revelacao); em ambiguo registra por que o campo e ambiguo
  // (anexada ao project_comments de discussao).
  justification?: string;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;
type SupabaseDataClient = ReturnType<typeof createSupabaseAdmin>;

interface ProjectCommentDraft {
  sourceFieldReviewId: string;
  fieldName: string;
  body: string;
}

// A revisão de origem identifica o único comentário automático que ela pode
// produzir. NULL permanece reservado aos comentários manuais; a UNIQUE do
// banco fecha retries concorrentes sem codificar identidade em strings.
async function insertMissingProjectComments(
  projectId: string,
  documentId: string,
  authorId: string,
  drafts: ProjectCommentDraft[],
): Promise<string | null> {
  if (drafts.length === 0) return null;
  // source_field_review_id é reservado ao backend: clientes autenticados só
  // podem criar comentários manuais. As validações e escritas de estado da
  // action já ocorreram pelo cliente RLS antes deste efeito recuperável.
  const admin = createSupabaseAdmin();
  const rows = drafts.map((draft) => ({
    project_id: projectId,
    document_id: documentId,
    field_name: draft.fieldName,
    author_id: authorId,
    body: draft.body,
    source_field_review_id: draft.sourceFieldReviewId,
  }));
  const { error } = await admin.from("project_comments").upsert(rows, {
    onConflict: "source_field_review_id",
    ignoreDuplicates: true,
  });
  return error?.message ?? null;
}

interface AutoReviewScope {
  projectId: string;
  documentId: string;
  accountUserId: string;
  memberUserId: string;
}

interface AutoReviewEffectState {
  id: string;
  self_verdict: SelfVerdict | null;
  self_justification: string | null;
  arbitrator_id: string | null;
  human_response_id: string;
  llm_response_id: string;
}

function duplicateValue<T>(
  values: T[],
  keyOf: (value: T) => string,
): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

function duplicateFieldName<T extends { fieldName: string }>(
  choices: T[],
): string | null {
  return duplicateValue(choices, (choice) => choice.fieldName);
}

function validateSelfVerdicts(verdicts: SelfVerdictInput[]): string | null {
  const duplicate = duplicateFieldName(verdicts);
  if (duplicate) return `Campo "${duplicate}" enviado mais de uma vez.`;

  for (const verdict of verdicts) {
    if (
      verdictRequiresJustification(verdict.verdict) &&
      !verdict.justification?.trim()
    ) {
      return verdict.verdict === "ambiguo"
        ? `Campo "${verdict.fieldName}": justificativa obrigatória quando você marca como ambíguo.`
        : `Campo "${verdict.fieldName}": justificativa obrigatória quando você contesta o LLM.`;
    }
  }
  return null;
}

async function persistSelfVerdicts(
  supabase: SupabaseServerClient,
  scope: AutoReviewScope,
  verdicts: SelfVerdictInput[],
): Promise<void> {
  const results = await Promise.all(
    verdicts.map((verdict) =>
      supabase
        .from("field_reviews")
        .update({
          self_verdict: verdict.verdict,
          self_justification: verdictRequiresJustification(verdict.verdict)
            ? (verdict.justification?.trim() ?? null)
            : null,
        })
        .eq("project_id", scope.projectId)
        .eq("document_id", scope.documentId)
        .eq("field_name", verdict.fieldName)
        .eq("self_reviewer_id", scope.memberUserId)
        .is("self_verdict", null),
    ),
  );

  for (const result of results) {
    if (result.error) throw new Error(result.error.message);
  }
}

async function loadAutoReviewEffects(
  supabase: SupabaseServerClient,
  scope: AutoReviewScope,
  verdicts: SelfVerdictInput[],
): Promise<Map<string, AutoReviewEffectState>> {
  const fieldNames = verdicts.map((verdict) => verdict.fieldName);
  if (fieldNames.length === 0) return new Map();

  const { data, error } = await supabase
    .from("field_reviews")
    .select(
      "id, field_name, self_verdict, self_justification, arbitrator_id, human_response_id, llm_response_id",
    )
    .eq("project_id", scope.projectId)
    .eq("document_id", scope.documentId)
    .eq("self_reviewer_id", scope.memberUserId)
    .in("field_name", fieldNames);
  if (error) throw new Error(error.message);

  return new Map(
    (data ?? []).map((row) => [
      row.field_name,
      {
        id: row.id,
        self_verdict: row.self_verdict,
        self_justification: row.self_justification,
        arbitrator_id: row.arbitrator_id,
        human_response_id: row.human_response_id,
        llm_response_id: row.llm_response_id,
      },
    ]),
  );
}

function normalizedSelfJustification(
  verdict: SelfVerdict,
  justification: string | null | undefined,
): string | null {
  return verdictRequiresJustification(verdict)
    ? (justification?.trim() ?? null)
    : null;
}

function validatePersistedSelfVerdicts(
  verdicts: SelfVerdictInput[],
  effects: Map<string, AutoReviewEffectState>,
): void {
  for (const verdict of verdicts) {
    const effect = effects.get(verdict.fieldName);
    if (!effect) {
      throw new Error(
        `Campo "${verdict.fieldName}": linha de revisão não encontrada ou sem permissão.`,
      );
    }
    if (effect.self_verdict !== verdict.verdict) {
      throw new Error(
        `Campo "${verdict.fieldName}": auto-revisão já registrada com valor diferente.`,
      );
    }
    if (
      normalizedSelfJustification(
        verdict.verdict,
        effect.self_justification,
      ) !== normalizedSelfJustification(verdict.verdict, verdict.justification)
    ) {
      throw new Error(
        `Campo "${verdict.fieldName}": a justificativa enviada difere da auto-revisão já registrada.`,
      );
    }
  }
}

async function persistEquivalentReviews(
  supabase: SupabaseServerClient,
  scope: AutoReviewScope,
  verdicts: SelfVerdictInput[],
  effects: Map<string, AutoReviewEffectState>,
): Promise<void> {
  const rows = verdicts.flatMap((verdict) => {
    const effect = effects.get(verdict.fieldName);
    if (
      verdict.verdict !== "equivalente" ||
      effect?.self_verdict !== "equivalente"
    ) {
      return [];
    }
    const [responseA, responseB] = canonicalPair(
      effect.human_response_id,
      effect.llm_response_id,
    );
    return [
      {
        project_id: scope.projectId,
        document_id: scope.documentId,
        field_name: verdict.fieldName,
        response_a_id: responseA,
        response_b_id: responseB,
        reviewer_id: scope.memberUserId,
      },
    ];
  });
  if (rows.length === 0) return;

  const { error } = await supabase.from("response_equivalences").upsert(rows, {
    onConflict: "project_id,document_id,field_name,response_a_id,response_b_id",
    ignoreDuplicates: true,
  });
  if (error) throw new Error(error.message);
}

interface ResponseAnswerState {
  id: string;
  answers: unknown;
}

async function loadResponsesById(
  supabase: SupabaseServerClient,
  responseIds: Iterable<string>,
): Promise<Map<string, ResponseAnswerState>> {
  const { data, error } = await supabase
    .from("responses")
    .select("id, answers")
    .in("id", Array.from(responseIds));
  if (error) throw new Error(error.message);

  return new Map(
    ((data ?? []) as ResponseAnswerState[]).map((response) => [
      response.id,
      response,
    ]),
  );
}

async function persistAmbiguousReviewComments(
  supabase: SupabaseServerClient,
  scope: AutoReviewScope,
  verdicts: SelfVerdictInput[],
  effects: Map<string, AutoReviewEffectState>,
): Promise<void> {
  const ambiguousVerdicts = verdicts.filter(
    (verdict) =>
      verdict.verdict === "ambiguo" &&
      effects.get(verdict.fieldName)?.self_verdict === "ambiguo",
  );
  if (ambiguousVerdicts.length === 0) return;

  const responseIds = new Set<string>();
  for (const verdict of ambiguousVerdicts) {
    const effect = effects.get(verdict.fieldName)!;
    responseIds.add(effect.human_response_id);
    responseIds.add(effect.llm_response_id);
  }
  const responsesById = await loadResponsesById(supabase, responseIds);
  const drafts = ambiguousVerdicts.map((verdict) => {
    const effect = effects.get(verdict.fieldName)!;
    const justification = effect.self_justification?.trim();
    if (!justification) {
      throw new Error(
        `Campo "${verdict.fieldName}": revisão ambígua sem justificativa persistida.`,
      );
    }
    const humanAnswer = formatAnswerTechnical(
      (
        responsesById.get(effect.human_response_id)?.answers as Record<
          string,
          unknown
        > | null
      )?.[verdict.fieldName],
    );
    const llmAnswer = formatAnswerTechnical(
      (
        responsesById.get(effect.llm_response_id)?.answers as Record<
          string,
          unknown
        > | null
      )?.[verdict.fieldName],
    );
    return {
      sourceFieldReviewId: effect.id,
      fieldName: verdict.fieldName,
      body: [
        `Campo "${verdict.fieldName}" marcado como ambíguo na auto-revisão.`,
        `Humano respondeu: ${humanAnswer}`,
        `LLM respondeu: ${llmAnswer}`,
        `Justificativa do pesquisador: ${justification}`,
        "Precisa de discussão para decidir o gabarito.",
      ].join("\n\n"),
    };
  });

  const commentError = await insertMissingProjectComments(
    scope.projectId,
    scope.documentId,
    scope.accountUserId,
    drafts,
  );
  if (commentError) throw new Error(commentError);
}

async function assignContestedAutoReviews(
  supabase: SupabaseServerClient,
  scope: AutoReviewScope,
  verdicts: SelfVerdictInput[],
  effects: Map<string, AutoReviewEffectState>,
): Promise<{ arbitrated: number; warning?: string }> {
  const contestedFields = verdicts.flatMap((verdict) =>
    verdict.verdict === "contesta_llm" &&
    effects.get(verdict.fieldName)?.self_verdict === "contesta_llm" &&
    effects.get(verdict.fieldName)?.arbitrator_id == null
      ? [verdict.fieldName]
      : [],
  );
  if (contestedFields.length === 0) return { arbitrated: 0 };

  const result = await assignArbitrator(
    supabase,
    scope.projectId,
    scope.documentId,
    scope.memberUserId,
    contestedFields,
  );
  const warning = result.noPool
    ? `Não há árbitros elegíveis para ${contestedFields.length} campo(s) contestado(s). Peça ao coordenador para marcar membros como elegíveis em Configuração → Equipe.`
    : undefined;
  return { arbitrated: result.count, warning };
}

// Humano original conclui sua fase de auto-revisao. Para cada campo:
//   - admite_erro  → gabarito do campo = LLM, fica resolvido
//   - contesta_llm → cai na fila de arbitragem (sorteia arbitro neste mesmo call)
//   - equivalente  → registra o par humano↔LLM em response_equivalences; campo
//                    fica resolvido, sem arbitragem
//   - ambiguo      → gera um project_comments para discussao; campo fica
//                    resolvido, sem arbitragem
//
// Idempotente: regravar a auto-revisao apos enviada nao reinicia arbitragem.
// O UPDATE só toca campos pendentes; efeitos recuperáveis consultam o estado
// persistido e usam upsert ou deduplicação exata.
export async function submitAutoReview(
  projectId: string,
  documentId: string,
  verdicts: SelfVerdictInput[],
): Promise<{
  success: boolean;
  error?: string;
  warning?: string;
  arbitrated?: number;
}> {
  try {
    const actor = await resolveProjectMemberActor(projectId);
    if (!actor.ok) return { success: false, error: actor.error };

    const validationError = validateSelfVerdicts(verdicts);
    if (validationError) return { success: false, error: validationError };

    const supabase = await createSupabaseServer();
    const now = new Date().toISOString();
    const scope: AutoReviewScope = {
      projectId,
      documentId,
      accountUserId: actor.user.id,
      memberUserId: actor.memberUserId,
    };
    await persistSelfVerdicts(supabase, scope, verdicts);

    const effects = await loadAutoReviewEffects(supabase, scope, verdicts);
    validatePersistedSelfVerdicts(verdicts, effects);
    await persistEquivalentReviews(supabase, scope, verdicts, effects);
    await persistAmbiguousReviewComments(supabase, scope, verdicts, effects);
    const result = await assignContestedAutoReviews(
      supabase,
      scope,
      verdicts,
      effects,
    );
    await syncAutoRevisaoAssignmentStatus(
      supabase,
      scope.projectId,
      scope.documentId,
      scope.memberUserId,
      now,
    );

    revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true, ...result };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

// Escolhe um arbitro elegível com balanceamento por carga; em empate na menor
// carga, sorteia aleatoriamente entre os candidatos para evitar viés
// estrutural em projetos pequenos. Prefere quem NÃO codificou o documento;
// quando isso é impossível, cai para qualquer elegível != auto-revisor.
//
// Granularidade: TODOS os campos contestados deste submit recebem o MESMO
// arbitro (um por documento, nao um por campo). Intencional para coerencia —
// o arbitro ve todos os campos do mesmo doc de uma vez. A tabela
// field_reviews permite arbitros diferentes por campo, mas este caminho
// (submit unico → 1 arbitro por doc) prefere coerencia sobre granularidade.
//
// Dois submits concorrentes ainda podem ler o mesmo `minLoad` e escolher o
// mesmo árbitro — isso só degrada o balanceamento. A correção não depende
// dessa leitura: a RPC final valida can_arbitrate sob lock e grava revisão +
// assignment na mesma transação, serializada com a desabilitação do membro.
//
// Idempotente: arbitrator_id so e gravado em field_reviews que ainda nao
// tem arbitro definido (re-chamadas nao trocam um arbitro ja escolhido).
//
// Retorna:
//  - count: quantidade de field_reviews efetivamente atribuidos
//  - noPool: true se o projeto não tem outros membros disponíveis (chamador
//    usa para alertar o pesquisador; sem esse sinal, o submit completa
//    silenciosamente e os campos ficam presos sem árbitro)
async function assignArbitrator(
  reader: SupabaseDataClient,
  projectId: string,
  documentId: string,
  excludeUserId: string,
  fieldNames: string[],
  precomputedCoderIds?: Set<string>,
  writeClient?: SupabaseDataClient,
): Promise<{ count: number; noPool: boolean }> {
  // Codificadores humanos deste documento — quem já tem resposta registrada
  // para o doc (recurso de comparação N+). Quando o caller pré-buscou em
  // batch (retryPendingArbitrations), reusa o set para evitar N queries.
  let coderIds: Set<string>;
  if (precomputedCoderIds) {
    coderIds = precomputedCoderIds;
  } else {
    const { data: coders, error: codersError } = await reader
      .from("responses")
      .select("respondent_id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("respondent_type", "humano");
    if (codersError) throw new Error(codersError.message);
    coderIds = new Set<string>();
    for (const c of coders ?? []) {
      if (c.respondent_id) coderIds.add(c.respondent_id as string);
    }
  }

  // Elegíveis (can_arbitrate) menos o auto-revisor original — esse nunca
  // arbitra, sob nenhuma circunstância, porque julgaria a própria resposta.
  const { data: eligibleMembers, error: membersError } = await reader
    .from("project_members")
    .select("user_id, role")
    .eq("project_id", projectId)
    .eq("can_arbitrate", true);
  if (membersError) throw new Error(membersError.message);
  const eligible = (eligibleMembers ?? []).filter(
    (member) => member.user_id !== excludeUserId,
  );

  // Pool ideal: árbitro que NÃO codificou o documento — totalmente neutro na
  // fase cega. Fallback: documentos codificados por toda a equipe elegível
  // (ex.: docs de calibração) não têm terceiro neutro possível; aceita-se
  // então qualquer elegível != auto-revisor — ele não julga a própria
  // resposta, ainda que tenha codificado o mesmo doc. noPool=true só quando
  // nem o fallback tem candidato → o caso cai no banner de pendências.
  const neutral = eligible.filter((m) => !coderIds.has(m.user_id));
  const members = neutral.length > 0 ? neutral : eligible;
  if (members.length === 0) return { count: 0, noPool: true };

  // Conta arbitragens abertas por candidato (balanceamento)
  const { data: openCounts, error: openCountsError } = await reader
    .from("assignments")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("type", "arbitragem")
    .neq("status", "concluido");
  if (openCountsError) throw new Error(openCountsError.message);

  const loadByUser = buildLoadMap(openCounts ?? []);

  // Carga minima entre candidatos
  let minLoad = Infinity;
  for (const m of members) {
    const l = loadByUser.get(m.user_id) ?? 0;
    if (l < minLoad) minLoad = l;
  }

  // Pesquisador tem prioridade sobre coordenador na menor carga
  const candidatesAtMinLoad = members.filter(
    (m) => (loadByUser.get(m.user_id) ?? 0) === minLoad,
  );
  const researchersAtMinLoad = candidatesAtMinLoad.filter(
    (m) => m.role === "pesquisador",
  );
  const finalPool =
    researchersAtMinLoad.length > 0
      ? researchersAtMinLoad
      : candidatesAtMinLoad;

  // Sorteio aleatorio entre os empatados
  const arbitratorId =
    finalPool[Math.floor(Math.random() * finalPool.length)].user_id;

  const { data: assigned, error: assignmentError } = await (
    writeClient ?? createSupabaseAdmin()
  ).rpc("assign_arbitration_if_eligible", {
    p_project_id: projectId,
    p_document_id: documentId,
    p_user_id: arbitratorId,
    p_field_names: fieldNames,
  });
  if (assignmentError) throw new Error(assignmentError.message);

  return { count: typeof assigned === "number" ? assigned : 0, noPool: false };
}

export interface BlindChoice {
  fieldReviewId: string;
  choice: "a" | "b";
}

function validateBlindChoices(choices: BlindChoice[]): string | null {
  for (const choice of choices) {
    if (
      typeof choice.fieldReviewId !== "string" ||
      choice.fieldReviewId.trim() === ""
    ) {
      return "ID da revisão cega é obrigatório.";
    }
    if (choice.choice !== "a" && choice.choice !== "b") {
      return `Escolha inválida para a revisão "${choice.fieldReviewId}".`;
    }
  }

  const duplicate = duplicateValue(choices, (choice) => choice.fieldReviewId);
  return duplicate ? `Revisão "${duplicate}" enviada mais de uma vez.` : null;
}

// Fase 1 da arbitragem: arbitro escolhe cegamente entre A/B (sem justificativa).
// O cliente envia apenas A/B; o servidor traduz para humano/llm via assignOrder
// (deterministico por fieldReviewId) — assim o mapeamento A/B → humano/llm
// nunca trafega para o navegador na fase cega, eliminando o vetor de
// inspecao via DevTools.
//
// So aceita escrever onde arbitrator_id = current user e blind_verdict IS NULL.
// Retries com mesmo verdict sao tolerados como no-op (idempotente); retries
// com verdict diferente retornam erro descritivo em vez de no-op silencioso.
export async function submitBlindVerdicts(
  projectId: string,
  documentId: string,
  choices: BlindChoice[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const actor = await resolveProjectMemberActor(projectId);
    if (!actor.ok) return { success: false, error: actor.error };

    const validationError = validateBlindChoices(choices);
    if (validationError) return { success: false, error: validationError };

    // Conta vinculada arbitra como o membro canônico (spec 002).
    const effectiveId = actor.memberUserId;

    const supabase = await createSupabaseServer();

    const results = await Promise.all(
      choices.map((c) => {
        const verdict = resolveBlindVerdict(c.fieldReviewId, c.choice);
        return supabase
          .from("field_reviews")
          .update({ blind_verdict: verdict })
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("id", c.fieldReviewId)
          .eq("arbitrator_id", effectiveId)
          .is("blind_verdict", null)
          .select("id");
      }),
    );

    // Detecta UPDATE de 0 linhas: pode ser RLS, linha inexistente OU ja
    // decidida. Re-fetch para diferenciar idempotente (mesmo verdict) de
    // conflito real.
    const failedIndices: number[] = [];
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.error) return { success: false, error: res.error.message };
      if (!res.data || res.data.length === 0) {
        failedIndices.push(i);
      }
    }

    if (failedIndices.length > 0) {
      const failedIds = failedIndices.map((i) => choices[i].fieldReviewId);
      const { data: existing, error: existingError } = await supabase
        .from("field_reviews")
        .select("id, blind_verdict")
        .in("id", failedIds)
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("arbitrator_id", effectiveId);
      if (existingError) {
        return { success: false, error: existingError.message };
      }
      const existingById = new Map(
        (existing ?? []).map((r) => [
          r.id as string,
          r.blind_verdict as ArbitrationVerdict | null,
        ]),
      );

      for (const i of failedIndices) {
        const c = choices[i];
        const expected = resolveBlindVerdict(c.fieldReviewId, c.choice);
        const current = existingById.get(c.fieldReviewId);
        if (current === undefined) {
          return {
            success: false,
            error: `Linha de revisão não encontrada ou sem permissão (${c.fieldReviewId}).`,
          };
        }
        if (current === expected) {
          continue; // idempotente OK
        }
        return {
          success: false,
          error: `Veredito cego já registrado com valor diferente para ${c.fieldReviewId}.`,
        };
      }
    }

    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

export interface FinalChoice {
  fieldName: string;
  verdict: ArbitrationVerdict;
  questionImprovementSuggestion?: string;
  arbitratorComment?: string;
}

interface FinalReviewState {
  id: string;
  field_name: string;
  human_response_id: string;
  llm_response_id: string;
  blind_verdict: ArbitrationVerdict | null;
  final_verdict: ArbitrationVerdict | null;
  question_improvement_suggestion: string | null;
  arbitrator_comment: string | null;
}

interface FinalVerdictScope {
  projectId: string;
  documentId: string;
  memberUserId: string;
}

type FinalResponseState = ResponseAnswerState;

function validateFinalChoices(choices: FinalChoice[]): string | null {
  const duplicate = duplicateFieldName(choices);
  if (duplicate) return `Campo "${duplicate}" enviado mais de uma vez.`;

  for (const choice of choices) {
    if (
      choice.verdict === "llm" &&
      !choice.questionImprovementSuggestion?.trim()
    ) {
      return `Campo "${choice.fieldName}": sugestão de melhoria obrigatória quando você decide pelo LLM contra o humano.`;
    }
  }
  return null;
}

function normalizedOptionalText(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function loadFinalReviews(
  supabase: SupabaseServerClient,
  scope: FinalVerdictScope,
  choices: FinalChoice[],
): Promise<FinalReviewState[]> {
  // As duas FKs de field_reviews para responses tornam o nested select
  // ambíguo no PostgREST; as respostas são carregadas separadamente.
  const { data, error } = await supabase
    .from("field_reviews")
    .select(
      "id, field_name, human_response_id, llm_response_id, blind_verdict, final_verdict, question_improvement_suggestion, arbitrator_comment",
    )
    .eq("project_id", scope.projectId)
    .eq("document_id", scope.documentId)
    .in(
      "field_name",
      choices.map((choice) => choice.fieldName),
    )
    .eq("arbitrator_id", scope.memberUserId);
  if (error) throw new Error(error.message);
  return (data ?? []) as FinalReviewState[];
}

function choicesNeedingFinalVerdict(
  choices: FinalChoice[],
  reviewsByField: Map<string, FinalReviewState>,
): FinalChoice[] {
  const pending: FinalChoice[] = [];
  for (const choice of choices) {
    const review = reviewsByField.get(choice.fieldName);
    if (!review) {
      throw new Error(
        `Campo "${choice.fieldName}": linha de revisão não encontrada ou sem permissão.`,
      );
    }
    if (review.blind_verdict == null) {
      throw new Error(
        `Campo "${choice.fieldName}": fase cega ainda não decidida.`,
      );
    }
    if (review.final_verdict == null) {
      pending.push(choice);
      continue;
    }
    if (review.final_verdict !== choice.verdict) {
      throw new Error(
        `Campo "${choice.fieldName}": veredito final já registrado como "${review.final_verdict}".`,
      );
    }
    if (
      normalizedOptionalText(review.question_improvement_suggestion) !==
        normalizedOptionalText(choice.questionImprovementSuggestion) ||
      normalizedOptionalText(review.arbitrator_comment) !==
        normalizedOptionalText(choice.arbitratorComment)
    ) {
      throw new Error(
        `Campo "${choice.fieldName}": os detalhes enviados diferem do veredito final já registrado.`,
      );
    }
  }
  return pending;
}

async function loadFinalResponses(
  supabase: SupabaseServerClient,
  reviews: FinalReviewState[],
  choices: FinalChoice[],
): Promise<Map<string, FinalResponseState>> {
  if (!choices.some((choice) => choice.verdict === "llm")) return new Map();

  const responseIds = new Set<string>();
  for (const review of reviews) {
    responseIds.add(review.human_response_id);
    responseIds.add(review.llm_response_id);
  }
  return loadResponsesById(supabase, responseIds);
}

async function persistFinalVerdicts(
  supabase: SupabaseServerClient,
  scope: FinalVerdictScope,
  choices: FinalChoice[],
): Promise<void> {
  // Os filtros impõem a sequência cego → final e tornam explícita a corrida
  // entre a leitura anterior e outro submit do mesmo árbitro.
  const results = await Promise.all(
    choices.map((choice) =>
      supabase
        .from("field_reviews")
        .update({
          final_verdict: choice.verdict,
          question_improvement_suggestion: normalizedOptionalText(
            choice.questionImprovementSuggestion,
          ),
          arbitrator_comment: normalizedOptionalText(choice.arbitratorComment),
        })
        .eq("project_id", scope.projectId)
        .eq("document_id", scope.documentId)
        .eq("field_name", choice.fieldName)
        .eq("arbitrator_id", scope.memberUserId)
        .not("blind_verdict", "is", null)
        .is("final_verdict", null)
        .select("id"),
    ),
  );

  const concurrentChoices: FinalChoice[] = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.error) throw new Error(result.error.message);
    if (!result.data || result.data.length === 0) {
      concurrentChoices.push(choices[index]);
    }
  }

  if (concurrentChoices.length === 0) return;

  // Outro request pode ter vencido entre a leitura inicial e o UPDATE. A
  // releitura aceita somente o mesmo payload completo; ausência, estado ainda
  // pendente ou qualquer divergência continuam sendo erro explícito.
  const concurrentReviews = await loadFinalReviews(
    supabase,
    scope,
    concurrentChoices,
  );
  const concurrentByField = new Map(
    concurrentReviews.map((review) => [review.field_name, review]),
  );
  const stillPending = choicesNeedingFinalVerdict(
    concurrentChoices,
    concurrentByField,
  );
  if (stillPending.length > 0) {
    throw new Error(
      `Campo "${stillPending[0].fieldName}": UPDATE rejeitado (concorrência ou RLS).`,
    );
  }
}

function buildFinalVerdictCommentDrafts(
  choices: FinalChoice[],
  reviewsByField: Map<string, FinalReviewState>,
  responsesById: Map<string, FinalResponseState>,
): ProjectCommentDraft[] {
  return choices.flatMap((choice) => {
    if (choice.verdict !== "llm") return [];

    const review = reviewsByField.get(choice.fieldName)!;
    const humanResponse = responsesById.get(review.human_response_id);
    const llmResponse = responsesById.get(review.llm_response_id);
    const humanAnswer = formatAnswerTechnical(
      (humanResponse?.answers as Record<string, unknown> | undefined)?.[
        choice.fieldName
      ],
    );
    const llmAnswer = formatAnswerTechnical(
      (llmResponse?.answers as Record<string, unknown> | undefined)?.[
        choice.fieldName
      ],
    );
    const body = [
      `Discordância em "${choice.fieldName}".`,
      `Humano respondeu: ${humanAnswer}`,
      `LLM respondeu: ${llmAnswer}`,
      "Árbitro manteve LLM.",
      `Sugestão de melhoria: ${normalizedOptionalText(choice.questionImprovementSuggestion)}`,
      normalizedOptionalText(choice.arbitratorComment)
        ? `Comentário: ${normalizedOptionalText(choice.arbitratorComment)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    return [
      {
        sourceFieldReviewId: review.id,
        fieldName: choice.fieldName,
        body,
      },
    ];
  });
}

async function persistFinalVerdictComments(
  scope: FinalVerdictScope,
  accountUserId: string,
  choices: FinalChoice[],
  reviewsByField: Map<string, FinalReviewState>,
  responsesById: Map<string, FinalResponseState>,
): Promise<void> {
  const drafts = buildFinalVerdictCommentDrafts(
    choices,
    reviewsByField,
    responsesById,
  );
  const error = await insertMissingProjectComments(
    scope.projectId,
    scope.documentId,
    accountUserId,
    drafts,
  );
  if (error) {
    throw new Error(
      `Veredicto salvo mas comentário de divergência falhou: ${error}`,
    );
  }
}

// Fase 2: arbitro confirma/troca veredito apos ver justificativa LLM.
// Se final_verdict='llm' (humano perdeu), exige question_improvement_suggestion
// e cria entry em project_comments com contexto da divergencia.
// Marca assignment arbitragem como concluido se TODOS os field_reviews do doc
// tiverem final_verdict definido.
export async function submitFinalVerdicts(
  projectId: string,
  documentId: string,
  choices: FinalChoice[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const actor = await resolveProjectMemberActor(projectId);
    if (!actor.ok) return { success: false, error: actor.error };

    // Conta vinculada arbitra como o membro canônico (spec 002).
    const scope: FinalVerdictScope = {
      projectId,
      documentId,
      memberUserId: actor.memberUserId,
    };

    const validationError = validateFinalChoices(choices);
    if (validationError) return { success: false, error: validationError };

    const supabase = await createSupabaseServer();
    const reviews = await loadFinalReviews(supabase, scope, choices);
    const reviewsByField = new Map(
      reviews.map((review) => [review.field_name, review]),
    );
    const choicesToUpdate = choicesNeedingFinalVerdict(choices, reviewsByField);
    const responsesById = await loadFinalResponses(supabase, reviews, choices);

    await persistFinalVerdicts(supabase, scope, choicesToUpdate);

    // A autoria é da conta autenticada; a fila permanece no membro canônico.
    await persistFinalVerdictComments(
      scope,
      actor.user.id,
      choices,
      reviewsByField,
      responsesById,
    );

    await syncArbitragemAssignmentStatus(
      supabase,
      scope.projectId,
      scope.documentId,
      scope.memberUserId,
    );

    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

// Coordenador-only: varre todas as respostas humanas concluidas do projeto e
// reconcilia o backlog de auto-revisao + field_reviews. Usado quando a chamada
// inline em saveResponse falhou silenciosamente (ver log "[auto-review]"), apos
// importar respostas em lote, ou apos uma edicao de schema que tornou campos
// antigos "stale" (campos adicionados depois de uma codificacao geravam
// field_reviews espurios com a resposta humana aparecendo como "(vazio)").
//
// Reconcile (nao so insert): alem de inserir o conjunto correto, remove
// field_reviews que nao deveriam mais existir — mas SO os ainda pendentes
// (self_verdict IS NULL). Linhas que o pesquisador ja resolveu nunca sao
// apagadas (apagar perderia trabalho); sao apenas contadas em `keptResolved`.
// Assignments auto_revisao que ficam sem nenhum field_review e ainda estao
// `pendente` sao removidos.
//
// Bulk-otimizado: queries em batch + upserts/deletes em batch, independente do
// numero de respostas.
interface BacklogInputs {
  fields: PydanticField[];
  humanResponses: HumanResponseRow[];
  llmResponses: LlmResponseRow[];
  equivalences: EquivalenceRow[];
  existingReviews: ExistingFieldReviewRow[];
}

// Batch de leitura inicial do backlog — lança em qualquer erro de query,
// convertido em { success: false, error } pelo try/catch de
// regenerateAutoReviewBacklog.
async function fetchBacklogInputs(
  admin: SupabaseDataClient,
  projectId: string,
): Promise<BacklogInputs> {
  const [
    { data: project, error: projErr },
    { data: humanResponses, error: humanErr },
    { data: llmResponses, error: llmErr },
    { data: equivalences, error: equivErr },
    { data: existingReviews, error: existingErr },
  ] = await Promise.all([
    admin
      .from("projects")
      .select("pydantic_fields")
      .eq("id", projectId)
      .single(),
    admin
      .from("responses")
      .select("id, document_id, respondent_id, answers, answer_field_hashes")
      .eq("project_id", projectId)
      .eq("respondent_type", "humano")
      .eq("is_partial", false),
    admin
      .from("responses")
      .select("id, document_id, answers, answer_field_hashes")
      .eq("project_id", projectId)
      .eq("respondent_type", "llm")
      .eq("is_latest", true),
    admin
      .from("response_equivalences")
      .select(
        "id, document_id, field_name, response_a_id, response_b_id, reviewer_id",
      )
      .eq("project_id", projectId),
    // Estado atual de field_reviews — usado no reconcile abaixo. Independe
    // do conjunto recem-computado, entao buscamos junto do batch inicial.
    admin
      .from("field_reviews")
      .select("id, document_id, field_name, self_verdict")
      .eq("project_id", projectId),
  ]);

  if (projErr) throw new Error(projErr.message);
  if (humanErr) throw new Error(humanErr.message);
  if (llmErr) throw new Error(llmErr.message);
  if (equivErr) throw new Error(equivErr.message);
  if (existingErr) throw new Error(existingErr.message);

  return {
    fields: (project?.pydantic_fields as PydanticField[]) ?? [],
    humanResponses: (humanResponses ?? []) as HumanResponseRow[],
    llmResponses: (llmResponses ?? []) as LlmResponseRow[],
    equivalences: (equivalences ?? []) as EquivalenceRow[],
    existingReviews: (existingReviews ?? []) as ExistingFieldReviewRow[],
  };
}

// As etapas puras (computeBacklogRows, diffReviewsToRemove, compositeKeySet)
// vivem em @/lib/auto-review-backlog — "use server" só pode exportar funções
// async (regra do Next), então o que é puro e testável fica fora deste arquivo.

// Remove assignments auto_revisao orfaos: sem nenhum field_review restante
// para o doc+pesquisador e ainda `pendente`. Assignments ja iniciados ou
// concluidos sao preservados. As duas leituras refletem o estado pos-
// delete/upsert e sao independentes entre si — buscadas em paralelo.
async function removeOrphanAssignments(
  admin: SupabaseDataClient,
  projectId: string,
): Promise<void> {
  const [
    { data: remainingReviews, error: remainingErr },
    { data: autoAssignments, error: autoErr },
  ] = await Promise.all([
    admin
      .from("field_reviews")
      .select("document_id, self_reviewer_id")
      .eq("project_id", projectId),
    admin
      .from("assignments")
      .select("id, document_id, user_id")
      .eq("project_id", projectId)
      .eq("type", "auto_revisao")
      .eq("status", "pendente"),
  ]);
  if (remainingErr) throw new Error(remainingErr.message);
  if (autoErr) throw new Error(autoErr.message);
  const docUserWithReviews = compositeKeySet(
    remainingReviews ?? [],
    (r) => `${r.document_id}|${r.self_reviewer_id}`,
  );

  const orphanAssignmentIds = (autoAssignments ?? []).flatMap((a) =>
    docUserWithReviews.has(`${a.document_id}|${a.user_id}`) ? [] : [a.id],
  );
  if (orphanAssignmentIds.length > 0) {
    const { error } = await admin
      .from("assignments")
      .delete()
      .in("id", orphanAssignmentIds);
    if (error) throw new Error(error.message);
  }
}

export async function regenerateAutoReviewBacklog(projectId: string): Promise<{
  success: boolean;
  error?: string;
  scanned?: number;
  regenerated?: number;
  removed?: number;
  keptResolved?: number;
}> {
  try {
    const gate = await requireCoordinator(
      projectId,
      "Apenas coordenadores podem regenerar o backlog.",
    );
    if (!gate.ok) return { success: false, error: gate.error };

    const supabase = await createSupabaseServer();
    const {
      fields,
      humanResponses,
      llmResponses,
      equivalences,
      existingReviews,
    } = await fetchBacklogInputs(supabase, projectId);

    if (fields.length === 0) {
      return { success: true, scanned: 0, regenerated: 0 };
    }

    // Index LLM por document_id para lookup O(1) no loop in-memory
    const llmByDocId = new Map(llmResponses.map((r) => [r.document_id, r]));
    const equivByDoc = buildEquivalenceMap(equivalences);

    const { assignmentRows, fieldReviewRows, regenerated } = computeBacklogRows(
      projectId,
      humanResponses,
      llmByDocId,
      equivByDoc,
      fields,
    );

    const { idsToDelete, keptResolved } = diffReviewsToRemove(
      existingReviews,
      fieldReviewRows,
    );

    // Structural field-review writes are service-only. Create that capability
    // only after the authenticated reads and pure reconciliation have passed.
    const admin =
      idsToDelete.length > 0 || fieldReviewRows.length > 0
        ? createSupabaseAdmin()
        : null;

    // Defesa em profundidade: `.is("self_verdict", null)` fecha a janela TOCTOU
    // entre a leitura de `existingReviews` (fetchBacklogInputs) e este DELETE.
    // Se um pesquisador resolver um campo nesse intervalo, o DB recusa a linha
    // mesmo que o id esteja em `idsToDelete`. `.select("id")` devolve as linhas
    // efetivamente apagadas, fonte da contagem `removed` retornada.
    let actuallyRemoved = 0;
    if (idsToDelete.length > 0) {
      const { data: deleted, error } = await admin!
        .from("field_reviews")
        .delete()
        .in("id", idsToDelete)
        .is("self_verdict", null)
        .select("id");
      if (error) return { success: false, error: error.message };
      actuallyRemoved = deleted?.length ?? 0;
    }

    if (assignmentRows.length > 0) {
      const { error } = await supabase
        .from("assignments")
        .upsert(assignmentRows, {
          onConflict: "document_id,user_id,type",
          ignoreDuplicates: true,
        });
      if (error) return { success: false, error: error.message };
    }
    if (fieldReviewRows.length > 0) {
      // NB: ignoreDuplicates reconcilia o *conjunto* de field_reviews
      // (doc+field), nao os ponteiros. Uma linha ja existente mantem seus
      // human_response_id/llm_response_id antigos mesmo que o LLM tenha
      // re-rodado desde entao — atualizar FKs stale fica fora deste reconcile.
      const { error } = await admin!
        .from("field_reviews")
        .upsert(fieldReviewRows, {
          onConflict: "document_id,field_name",
          ignoreDuplicates: true,
        });
      if (error) return { success: false, error: error.message };
    }

    await removeOrphanAssignments(supabase, projectId);

    revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return {
      success: true,
      scanned: humanResponses.length,
      regenerated,
      removed: actuallyRemoved,
      keptResolved,
    };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

// Re-tenta alocar árbitro para todo field_review do projeto que está pendente
// (self_verdict='contesta_llm' AND arbitrator_id IS NULL). Disparada quando o
// coordenador habilita um novo membro como elegível em setCanArbitrate, para
// drenar o backlog acumulado enquanto não havia ninguém.
//
// Agrupa por (document_id, self_reviewer_id) e chama assignArbitrator para
// cada grupo — preserva a regra "todos os campos contestados do mesmo doc
// recebem o MESMO árbitro" e a exclusão do auto-revisor original do pool.
export async function retryPendingArbitrations(projectId: string): Promise<{
  success: boolean;
  error?: string;
  assigned: number;
  stillNoPool: number;
}> {
  try {
    const gate = await requireCoordinator(
      projectId,
      "Apenas coordenadores podem reprocessar arbitragens.",
    );
    if (!gate.ok)
      return { success: false, error: gate.error, assigned: 0, stillNoPool: 0 };

    const supabase = await createSupabaseServer();
    const { data: pending, error } = await supabase
      .from("field_reviews")
      .select("document_id, field_name, self_reviewer_id")
      .eq("project_id", projectId)
      .eq("self_verdict", "contesta_llm")
      .is("arbitrator_id", null);
    if (error)
      return {
        success: false,
        error: error.message,
        assigned: 0,
        stillNoPool: 0,
      };
    if (!pending || pending.length === 0)
      return { success: true, assigned: 0, stillNoPool: 0 };

    const groups = new Map<
      string,
      { documentId: string; selfReviewerId: string; fieldNames: string[] }
    >();
    for (const p of pending) {
      const key = `${p.document_id}|${p.self_reviewer_id}`;
      const g = groups.get(key) ?? {
        documentId: p.document_id as string,
        selfReviewerId: p.self_reviewer_id as string,
        fieldNames: [] as string[],
      };
      g.fieldNames.push(p.field_name as string);
      groups.set(key, g);
    }

    // Pré-busca em batch: codificadores humanos de todos os docs pendentes
    // de uma vez. assignArbitrator originalmente faz 1 SELECT em responses
    // por chamada — em loop de N groups isso vira N queries. Centralizar
    // num único SELECT mantém a chamada O(1) em queries de responses
    // independente do tamanho do backlog.
    const allDocIds = [
      ...new Set([...groups.values()].map((g) => g.documentId)),
    ];
    const codersByDoc = new Map<string, Set<string>>();
    if (allDocIds.length > 0) {
      const { data: allCoders, error: codersError } = await supabase
        .from("responses")
        .select("document_id, respondent_id")
        .eq("project_id", projectId)
        .in("document_id", allDocIds)
        .eq("respondent_type", "humano");
      if (codersError) throw new Error(codersError.message);
      for (const c of allCoders ?? []) {
        const docId = c.document_id as string;
        const respId = c.respondent_id as string | null;
        if (!respId) continue;
        let set = codersByDoc.get(docId);
        if (!set) {
          set = new Set<string>();
          codersByDoc.set(docId, set);
        }
        set.add(respId);
      }
    }

    // Sequencial intencionalmente: cada assignArbitrator lê openCounts
    // recalculado, preservando o balanceamento entre grupos. Paralelizar com
    // Promise.all faria todos os groups verem o mesmo minLoad e sortearem
    // dentro do mesmo pool — degrada a distribuição (mesma race tolerada em
    // submitAutoReview concorrente para docs diferentes, mas aqui evitável
    // a custo zero porque o loop está dentro de uma única chamada).
    let assigned = 0;
    let stillNoPool = 0;
    for (const g of groups.values()) {
      // Sequencial intencional (ver comentário acima): cada assignArbitrator lê
      // openCounts recalculado; paralelizar degradaria a distribuição.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await assignArbitrator(
        supabase,
        projectId,
        g.documentId,
        g.selfReviewerId,
        g.fieldNames,
        codersByDoc.get(g.documentId) ?? new Set<string>(),
      );
      assigned += result.count;
      if (result.noPool) stillNoPool++;
    }

    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    revalidatePath(`/projects/${projectId}/config/members`);
    return { success: true, assigned, stillNoPool };
  } catch (e) {
    return {
      success: false,
      error: errorMessage(e) || "Erro",
      assigned: 0,
      stillNoPool: 0,
    };
  }
}
