"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import {
  getAuthUser,
  getEffectiveMemberId,
  requireCoordinator,
} from "@/lib/auth";
import { buildLoadMap, pendingRetryFailure } from "@/lib/load-balancing";
import { errorMessage } from "@/lib/utils";
import { buildEquivalenceMap, type EquivalenceRow } from "@/lib/compare-queue";
import {
  computeBacklogRows,
  diffReviewsToRemove,
  filterCurrentMemberResponses,
  type ExistingFieldReviewRow,
  type HumanResponseRow,
  type LlmResponseRow,
} from "@/lib/auto-review-backlog";
import { resolveBlindVerdict } from "@/lib/arbitration-order";
import { verdictRequiresJustification } from "@/lib/auto-review-decided";
import { revalidatePath } from "next/cache";
import type {
  PydanticField,
  SelfVerdict,
  ArbitrationVerdict,
} from "@/lib/types";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;
type SupabaseAdminClient = ReturnType<typeof createSupabaseAdmin>;

export interface SelfVerdictInput {
  fieldReviewId: string;
  fieldName: string;
  verdict: SelfVerdict;
  justification?: string;
}

function selfVerdictValidationError(
  verdicts: SelfVerdictInput[],
): string | undefined {
  const invalid = verdicts.find(
    (verdict) =>
      verdictRequiresJustification(verdict.verdict) &&
      !verdict.justification?.trim(),
  );
  if (!invalid) return undefined;

  return invalid.verdict === "ambiguo"
    ? `Campo "${invalid.fieldName}": justificativa obrigatória quando você marca como ambíguo.`
    : `Campo "${invalid.fieldName}": justificativa obrigatória quando você contesta o LLM.`;
}

async function assignContestedFields(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  reviewerId: string,
  fields: Array<{ fieldName: string }>,
): Promise<{ arbitrated: number; warning?: string }> {
  if (fields.length === 0) return { arbitrated: 0 };

  const assignmentClient = createSupabaseAdmin();
  const assignment = await assignArbitrator(
    supabase,
    assignmentClient,
    projectId,
    documentId,
    reviewerId,
    fields.map((field) => field.fieldName),
  );
  return {
    arbitrated: assignment.count,
    warning: assignment.noPool
      ? `Não há árbitros elegíveis para ${fields.length} campo(s) contestado(s). Peça ao coordenador para marcar membros como elegíveis em Configuração → Equipe.`
      : undefined,
  };
}

async function finishAutoReview(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  reviewerId: string,
  contestedFields: Array<{ fieldReviewId: string; fieldName: string }>,
): Promise<{ success: true; arbitrated: number; warning?: string }> {
  let arbitrated = 0;
  let warning: string | undefined;
  try {
    ({ arbitrated, warning } = await assignContestedFields(
      supabase,
      projectId,
      documentId,
      reviewerId,
      contestedFields,
    ));
  } catch (assignmentError) {
    warning = "Auto-revisão salva; a alocação de arbitragem ficou pendente.";
    console.error(
      `[submitAutoReview] falha pós-commit ao alocar arbitragem: ${errorMessage(assignmentError)}`,
    );
  }

  try {
    revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
  } catch (revalidationError) {
    console.error(
      `[submitAutoReview] falha pós-commit ao revalidar: ${errorMessage(revalidationError)}`,
    );
  }
  return { success: true, arbitrated, warning };
}

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
    if (!(await getAuthUser())) {
      return { success: false, error: "Não autenticado" };
    }
    const effectiveId = await getEffectiveMemberId(projectId);
    const validationError = selfVerdictValidationError(verdicts);
    if (validationError) return { success: false, error: validationError };

    const supabase = await createSupabaseServer();
    const { data, error } = await supabase.rpc("submit_self_review", {
      p_project_id: projectId,
      p_document_id: documentId,
      p_reviewer_id: effectiveId,
      p_decisions: verdicts.map((verdict) => ({
        fieldReviewId: verdict.fieldReviewId,
        verdict: verdict.verdict,
        justification: verdict.justification?.trim() || null,
      })),
    });
    if (error) return { success: false, error: error.message };

    const result = data as {
      needsArbitrator?: Array<{ fieldReviewId: string; fieldName: string }>;
    } | null;
    return finishAutoReview(
      supabase,
      projectId,
      documentId,
      effectiveId,
      result?.needsArbitrator ?? [],
    );
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
  readClient: SupabaseServerClient,
  assignmentClient: SupabaseAdminClient,
  projectId: string,
  documentId: string,
  excludeUserId: string,
  fieldNames: string[],
  precomputedCoderIds?: Set<string>,
): Promise<{ count: number; noPool: boolean }> {
  // Codificadores humanos deste documento — quem já tem resposta registrada
  // para o doc (recurso de comparação N+). Quando o caller pré-buscou em
  // batch (retryPendingArbitrations), reusa o set para evitar N queries.
  let coderIds: Set<string>;
  if (precomputedCoderIds) {
    coderIds = precomputedCoderIds;
  } else {
    const { data: coders, error: codersError } = await readClient
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
  const { data: eligibleMembers, error: eligibleError } = await readClient
    .from("project_members")
    .select("user_id, role")
    .eq("project_id", projectId)
    .eq("can_arbitrate", true);
  if (eligibleError) throw new Error(eligibleError.message);
  const eligible = (eligibleMembers ?? []).filter(
    (m) => m.user_id !== excludeUserId,
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
  const { data: openCounts, error: openCountsError } = await readClient
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

  const { data: assigned, error: assignmentError } = await assignmentClient.rpc(
    "assign_arbitration_if_eligible",
    {
      p_project_id: projectId,
      p_document_id: documentId,
      p_user_id: arbitratorId,
      p_field_names: fieldNames,
    },
  );
  if (assignmentError) throw new Error(assignmentError.message);

  return { count: typeof assigned === "number" ? assigned : 0, noPool: false };
}

export interface BlindChoice {
  fieldReviewId: string;
  choice: "a" | "b";
}

async function submitArbitrationPhase(
  projectId: string,
  submit: (
    supabase: SupabaseServerClient,
    effectiveId: string,
  ) => Promise<{ error: { message: string } | null }>,
  validate?: () => string | undefined,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!(await getAuthUser())) {
      return { success: false, error: "Não autenticado" };
    }
    const validationError = validate?.();
    if (validationError) return { success: false, error: validationError };

    const effectiveId = await getEffectiveMemberId(projectId);
    const supabase = await createSupabaseServer();
    const { error } = await submit(supabase, effectiveId);
    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
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
  return submitArbitrationPhase(projectId, async (supabase, effectiveId) => {
    const { error } = await supabase.rpc("submit_blind_arbitration", {
      p_project_id: projectId,
      p_document_id: documentId,
      p_arbitrator_id: effectiveId,
      p_decisions: choices.map((choice) => ({
        fieldReviewId: choice.fieldReviewId,
        verdict: resolveBlindVerdict(choice.fieldReviewId, choice.choice),
      })),
    });
    return { error };
  });
}

export interface FinalChoice {
  fieldReviewId: string;
  fieldName: string;
  verdict: ArbitrationVerdict;
  questionImprovementSuggestion?: string;
  arbitratorComment?: string;
}

function finalChoiceValidationError(
  choices: FinalChoice[],
): string | undefined {
  const invalid = choices.find(
    (choice) =>
      choice.verdict === "llm" && !choice.questionImprovementSuggestion?.trim(),
  );
  return invalid
    ? `Campo "${invalid.fieldName}": sugestão de melhoria obrigatória quando você decide pelo LLM contra o humano.`
    : undefined;
}

export async function submitFinalVerdicts(
  projectId: string,
  documentId: string,
  choices: FinalChoice[],
): Promise<{ success: boolean; error?: string }> {
  return submitArbitrationPhase(
    projectId,
    async (supabase, arbitratorId) => {
      const { error } = await supabase.rpc("submit_final_arbitration", {
        p_project_id: projectId,
        p_document_id: documentId,
        p_arbitrator_id: arbitratorId,
        p_decisions: choices.map((choice) => ({
          fieldReviewId: choice.fieldReviewId,
          verdict: choice.verdict,
          questionImprovementSuggestion:
            choice.questionImprovementSuggestion?.trim() || null,
          arbitratorComment: choice.arbitratorComment?.trim() || null,
        })),
      });
      return { error };
    },
    () => finalChoiceValidationError(choices),
  );
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
// `pendente` sao removidos. Todas as mutações vivem numa única RPC, que
// revalida e bloqueia o papel coordenador até o commit.
//
// Bulk-otimizado: queries em batch + upserts/deletes em batch, independente do
// numero de respostas.
// Leituras e a RPC recebem o cliente autenticado. A RPC SECURITY DEFINER é o
// único ponto com privilégio para reconciliar field_reviews de outros membros.

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
  client: SupabaseServerClient,
  projectId: string,
): Promise<BacklogInputs> {
  const [
    { data: project, error: projErr },
    { data: humanResponses, error: humanErr },
    { data: llmResponses, error: llmErr },
    { data: equivalences, error: equivErr },
    { data: existingReviews, error: existingErr },
    { data: currentMembers, error: membersErr },
  ] = await Promise.all([
    client
      .from("projects")
      .select("pydantic_fields")
      .eq("id", projectId)
      .single(),
    client
      .from("responses")
      .select("id, document_id, respondent_id, answers, answer_field_hashes")
      .eq("project_id", projectId)
      .eq("respondent_type", "humano")
      .eq("is_partial", false),
    client
      .from("responses")
      .select("id, document_id, answers, answer_field_hashes")
      .eq("project_id", projectId)
      .eq("respondent_type", "llm")
      .eq("is_latest", true),
    client
      .from("response_equivalences")
      .select(
        "id, document_id, field_name, response_a_id, response_b_id, reviewer_id",
      )
      .eq("project_id", projectId),
    // Estado atual de field_reviews — usado no reconcile abaixo. Independe
    // do conjunto recem-computado, entao buscamos junto do batch inicial.
    client
      .from("field_reviews")
      .select("id, document_id, field_name, self_verdict")
      .eq("project_id", projectId),
    client
      .from("project_members")
      .select("user_id")
      .eq("project_id", projectId),
  ]);

  if (projErr) throw new Error(projErr.message);
  if (humanErr) throw new Error(humanErr.message);
  if (llmErr) throw new Error(llmErr.message);
  if (equivErr) throw new Error(equivErr.message);
  if (existingErr) throw new Error(existingErr.message);
  if (membersErr) throw new Error(membersErr.message);

  return {
    fields: (project?.pydantic_fields as PydanticField[]) ?? [],
    humanResponses: filterCurrentMemberResponses(
      (humanResponses ?? []) as HumanResponseRow[],
      (currentMembers ?? []).map((member) => member.user_id),
    ),
    llmResponses: (llmResponses ?? []) as LlmResponseRow[],
    equivalences: (equivalences ?? []) as EquivalenceRow[],
    existingReviews: (existingReviews ?? []) as ExistingFieldReviewRow[],
  };
}

// As etapas puras (computeBacklogRows, diffReviewsToRemove)
// vivem em @/lib/auto-review-backlog — "use server" só pode exportar funções
// async (regra do Next), então o que é puro e testável fica fora deste arquivo.

type ComputedBacklog = ReturnType<typeof computeBacklogRows>;

async function reconcileBacklogWrites(
  admin: SupabaseAdminClient,
  projectId: string,
  actorId: string,
  idsToDelete: string[],
  fieldReviewRows: ComputedBacklog["fieldReviewRows"],
): Promise<number> {
  const { data, error } = await admin.rpc("reconcile_auto_review_backlog", {
    p_project_id: projectId,
    p_actor_id: actorId,
    p_field_review_rows: fieldReviewRows.map(
      ({
        document_id,
        field_name,
        human_response_id,
        llm_response_id,
        self_reviewer_id,
      }) => ({
        document_id,
        field_name,
        human_response_id,
        llm_response_id,
        self_reviewer_id,
      }),
    ),
    p_ids_to_delete: idsToDelete,
  });
  if (error) throw new Error(error.message);
  return typeof data === "number" ? data : 0;
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
    const { fields, humanResponses, llmResponses, equivalences, existingReviews } =
      await fetchBacklogInputs(supabase, projectId);

    if (fields.length === 0) {
      return { success: true, scanned: 0, regenerated: 0 };
    }

    // Index LLM por document_id para lookup O(1) no loop in-memory
    const llmByDocId = new Map(llmResponses.map((r) => [r.document_id, r]));
    const equivByDoc = buildEquivalenceMap(equivalences);

    const { fieldReviewRows, regenerated } = computeBacklogRows(
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

    const actuallyRemoved = await reconcileBacklogWrites(
      createSupabaseAdmin(),
      projectId,
      gate.user.id,
      idsToDelete,
      fieldReviewRows,
    );

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
    const assignmentClient = createSupabaseAdmin();

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
      const { data: allCoders, error: allCodersError } = await supabase
        .from("responses")
        .select("document_id, respondent_id")
        .eq("project_id", projectId)
        .in("document_id", allDocIds)
        .eq("respondent_type", "humano");
      if (allCodersError) throw new Error(allCodersError.message);
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
        assignmentClient,
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
    return pendingRetryFailure(e);
  }
}
