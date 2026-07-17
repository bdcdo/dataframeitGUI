"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import {
  createRng,
  distributeDocs,
  filterComparisonEligible,
  filterEligibleDocs,
  shuffleWithRng,
  computeCapacity,
  resolveWeight,
  resolveCap,
  resolveResearchersPerDoc,
  type LotteryBalancing,
  type LotteryDocStats,
  type LotteryFilters,
  type LotteryMode,
  type LotteryParticipant,
} from "@/lib/lottery-utils";
import { MEMBERS_TAG_PROFILE, membersTag } from "@/lib/cache";
import { errorMessage } from "@/lib/utils";

/**
 * Cicla a atribuição de um par (documento, pesquisador) por três estados:
 *   vazio → codificacao → comparacao → vazio
 *
 * Assignments em_andamento/concluido de qualquer tipo bloqueiam o ciclo.
 * Só atribuições pendentes podem ser modificadas/removidas.
 */
export async function cycleAssignment(
  projectId: string,
  documentId: string,
  userId: string,
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServer();

  const { data: existing } = await supabase
    .from("assignments")
    .select("id, status, type")
    .eq("document_id", documentId)
    .eq("user_id", userId);

  const rows = existing || [];

  // Bloquear ciclo se houver assignment não-pendente de qualquer tipo
  const hasNonPending = rows.some((r) => r.status !== "pendente");
  if (hasNonPending) return {};

  const pendingCod = rows.find((r) => r.type === "codificacao");
  const pendingComp = rows.find((r) => r.type === "comparacao");

  try {
    if (!pendingCod && !pendingComp) {
      // vazio → codificacao
      const { error } = await supabase.from("assignments").insert({
        project_id: projectId,
        document_id: documentId,
        user_id: userId,
        type: "codificacao",
      });
      if (error) throw new Error(error.message);
    } else if (pendingCod && !pendingComp) {
      // codificacao → comparacao (UPDATE atômico, preserva id e metadados)
      const { error } = await supabase
        .from("assignments")
        .update({ type: "comparacao" })
        .eq("id", pendingCod.id);
      // Este ciclo enxerga só o par (documento, usuário) — não sabe de
      // comparações de OUTROS usuários no mesmo documento. Quem barra é o índice
      // assignments_one_active_comparacao_per_doc (um revisor por documento).
      // Traduzir em vez de vazar o texto do Postgres para o toast do coordenador.
      if (error?.code === "23505") {
        return { error: "Este documento já tem um revisor de comparação atribuído." };
      }
      if (error) throw new Error(error.message);
    } else if (pendingComp && !pendingCod) {
      // comparacao → vazio
      const { error } = await supabase.from("assignments").delete().eq("id", pendingComp.id);
      if (error) throw new Error(error.message);
    } else if (pendingCod && pendingComp) {
      // "ambos" (vindo de sorteio): remover tudo para voltar ao vazio
      const { error } = await supabase
        .from("assignments")
        .delete()
        .in("id", [pendingCod.id, pendingComp.id]);
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao alterar a atribuição" };
  }

  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  return {};
}

export async function clearPendingAssignments(
  projectId: string,
  type: "codificacao" | "comparacao" = "codificacao"
): Promise<{ deleted?: number; error?: string }> {
  const supabase = await createSupabaseServer();

  const { count, error } = await supabase
    .from("assignments")
    .delete({ count: "exact" })
    .eq("project_id", projectId)
    .eq("status", "pendente")
    .eq("type", type);

  if (error) {
    return { error: error.message || "Erro ao limpar as atribuições pendentes" };
  }

  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  return { deleted: count ?? 0 };
}

// --- Smart Lottery (spec 001) ---

interface LotteryParamsBase {
  projectId: string;
  mode: LotteryMode;
  balancing: LotteryBalancing;
  /** semente da prévia (research D13); ausente = gerar nova */
  seed?: number;
  docsPerResearcher?: number;
  docSubsetSize?: number;
  label?: string;
  filters?: LotteryFilters;
  participantIds: string[];
  /**
   * Peso e limite por participante (spec: carga desigual). weight escala a
   * carga na distribuição (default 1); cap é o teto absoluto de docs novos do
   * participante (null/ausente = sem limite individual). Persistido em
   * project_members ao sortear para pré-preencher o próximo sorteio.
   */
  participantSettings?: Record<string, { weight?: number; cap?: number | null }>;
}

/**
 * União discriminada por `type`: "comparação com 2 revisores" deixa de ser
 * construível — o braço `comparacao` não tem o campo. A regra é um revisor de
 * comparação por documento (ver COMPARISON_REVIEWERS_PER_DOC, issue #490).
 *
 * ATENÇÃO: isto é garantia de COMPILAÇÃO, para o client. Server Action é
 * endpoint HTTP público e o projeto não valida com zod — um payload forjado
 * chega com `{ type: "comparacao", researchersPerDoc: 5 }` sem passar por
 * type-check nenhum. As garantias de runtime são `resolveResearchersPerDoc` em
 * computeLottery (que ignora o valor recebido) e, no banco, o índice
 * assignments_one_active_comparacao_per_doc. O `researchersPerDoc?: never`
 * existe só para o excess property check pegar o literal no client.
 */
export type LotteryParams =
  | (LotteryParamsBase & { type: "codificacao"; researchersPerDoc: number })
  | (LotteryParamsBase & { type: "comparacao"; researchersPerDoc?: never });

interface LotteryAssignment {
  document_id: string;
  user_id: string;
}

export interface LotteryPreview {
  participants: { userId: string; existing: number; newDocs: number }[];
  totalNew: number;
  totalPreserved: number;
  /** nº de docs elegíveis pós-filtros (pré-subset) */
  eligibleDocs: number;
  /** semente usada; o dialog a reenvia em smartRandomize (research D13) */
  seed: number;
}

interface LotteryDocStatsResult {
  docs: LotteryDocStats[];
  batches: { id: string; label: string | null; createdAt: string }[];
  minResponsesForComparison: number;
  /** modo de automação do projeto — governa o gate de comparação */
  automationMode: string | null;
}

interface LotteryData extends LotteryDocStatsResult {
  assignmentRows: {
    document_id: string;
    user_id: string;
    status: string;
    type: string;
  }[];
  humanCoderRows: {
    document_id: string;
    respondent_id: string;
  }[];
}

/**
 * Stats por documento a partir da view `lottery_doc_stats` (issue #182):
 * agrega humanCodingCount/hasLlmResponse/activeAssignments/hasAnyAssignmentEver/
 * batchIds em Postgres, bounded pelo nº de documentos ativos do projeto — sem
 * tocar responses/assignments crus.
 */
async function fetchLotteryDocStats(projectId: string): Promise<LotteryDocStatsResult> {
  const supabase = await createSupabaseServer();

  const [{ data: docs }, { data: batches }, { data: project }] = await Promise.all([
    supabase
      .from("lottery_doc_stats")
      .select(
        "id, external_id, title, human_coding_count, has_llm_response, active_codificacao, active_comparacao, has_any_assignment_ever, batch_ids"
      )
      .eq("project_id", projectId),
    supabase
      .from("assignment_batches")
      .select("id, label, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
    supabase
      .from("projects")
      .select("min_responses_for_comparison, automation_mode")
      .eq("id", projectId)
      .single(),
  ]);

  return {
    docs: (docs || []).map((d) => ({
      id: d.id,
      externalId: d.external_id,
      title: d.title,
      humanCodingCount: d.human_coding_count,
      hasLlmResponse: d.has_llm_response,
      activeAssignments: {
        codificacao: d.active_codificacao,
        comparacao: d.active_comparacao,
      },
      hasAnyAssignmentEver: d.has_any_assignment_ever,
      batchIds: d.batch_ids || [],
    })),
    batches: (batches || []).map((b) => ({
      id: b.id,
      label: b.label,
      createdAt: b.created_at,
    })),
    minResponsesForComparison: project?.min_responses_for_comparison ?? 2,
    automationMode: project?.automation_mode ?? null,
  };
}

/**
 * Stats agregadas (via fetchLotteryDocStats) + linhas brutas de assignments,
 * necessárias em computeLottery para o conjunto preservado e a matriz de
 * coocorrência entre participantes — aritmética por par documento×usuário
 * que a view não resolve. Esse fetch bruto segue sem teto (issue de
 * acompanhamento da #182).
 */
async function fetchLotteryData(projectId: string): Promise<LotteryData> {
  const supabase = await createSupabaseServer();

  const [stats, { data: assignments }, { data: humanCoders }] = await Promise.all([
    fetchLotteryDocStats(projectId),
    supabase
      .from("assignments")
      .select("document_id, user_id, status, type")
      .eq("project_id", projectId),
    // Mesmo predicado do trigger enforce_comparison_assignment_actor
    // (20260716160100): resposta humana is_latest define quem codificou.
    supabase
      .from("responses")
      .select("document_id, respondent_id")
      .eq("project_id", projectId)
      .eq("respondent_type", "humano")
      .eq("is_latest", true)
      .not("respondent_id", "is", null),
  ]);

  return {
    ...stats,
    assignmentRows: (assignments || []).map((a) => ({
      document_id: a.document_id,
      user_id: a.user_id,
      status: a.status,
      type: a.type,
    })),
    humanCoderRows: (humanCoders || []).flatMap((r) =>
      r.respondent_id
        ? [{ document_id: r.document_id, respondent_id: r.respondent_id }]
        : [],
    ),
  };
}

/**
 * Stats leves por documento, carregadas uma vez na abertura do dialog.
 * O client reaplica filterEligibleDocs sobre elas para contagem ao vivo.
 */
export async function getLotteryDocStats(
  projectId: string,
): Promise<Partial<LotteryDocStatsResult> & { error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  try {
    const { docs, batches, minResponsesForComparison, automationMode } =
      await fetchLotteryDocStats(projectId);
    return { docs, batches, minResponsesForComparison, automationMode };
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao carregar as estatísticas do sorteio" };
  }
}

async function computeLottery(params: LotteryParams): Promise<{
  newAssignments: LotteryAssignment[];
  preservedCount: number;
  preservedByUser: Record<string, number>;
  eligibleCount: number;
  seed: number;
  batchData: Record<string, unknown>;
  /** tipo normalizado aqui — quem grava reusa em vez de renormalizar */
  assignmentType: "codificacao" | "comparacao";
}> {
  const supabase = await createSupabaseServer();
  // Normaliza em vez de confiar no literal: o payload chega por HTTP e não passa
  // por zod. Qualquer coisa que não seja "comparacao" é codificação.
  const assignmentType =
    params.type === "comparacao" ? "comparacao" : "codificacao";
  // Para comparação o valor pedido é ignorado (sempre 1) — a união discriminada
  // já proíbe o campo no client, e este é o guard para quem vem de fora dela.
  const researchersPerDoc = resolveResearchersPerDoc(
    assignmentType,
    (params as { researchersPerDoc?: number }).researchersPerDoc,
  );
  const filters = params.filters || {};

  if (filters.batchFilter?.only && filters.batchFilter?.exclude?.length) {
    throw new Error("Os filtros de lote são mutuamente exclusivos.");
  }

  const [{ data: members }, data] = await Promise.all([
    supabase
      .from("project_members")
      .select("user_id")
      .eq("project_id", params.projectId),
    fetchLotteryData(params.projectId),
  ]);

  // Pool de participantes: deduplicado e validado contra project_members
  // (qualquer role) — defesa em profundidade além do RLS (research D5)
  const memberIds = new Set((members || []).map((m) => m.user_id));
  const uniqueIds = [...new Set(params.participantIds)];
  const participantIds = uniqueIds.filter((id) => memberIds.has(id));
  if (!participantIds.length || participantIds.length !== uniqueIds.length) {
    throw new Error("Necessário ter ao menos um participante válido.");
  }

  if (!data.docs.length) {
    throw new Error("Necessário ter documentos.");
  }

  // Gate de comparação derivado do modo de automação — compõe com os filtros.
  // compare_llm exige 1 humano + LLM; demais modos exigem N humanos.
  let candidateDocs = data.docs;
  if (assignmentType === "comparacao") {
    candidateDocs = filterComparisonEligible(
      candidateDocs,
      data.automationMode,
      data.minResponsesForComparison,
    );
    if (!candidateDocs.length) {
      throw new Error(
        data.automationMode === "compare_llm"
          ? "Nenhum documento tem resposta humana e do LLM para comparação."
          : "Nenhum documento tem respostas humanas suficientes para comparação.",
      );
    }
  }

  const filteredDocs = filterEligibleDocs(candidateDocs, assignmentType, filters);
  if (!filteredDocs.length) {
    throw new Error("Nenhum documento passa nos filtros atuais.");
  }

  // Conjunto preservado conforme o modo (research D4): append preserva
  // todas as atribuições do tipo (inclusive pendentes); replace só as que
  // o sorteio nunca toca (em_andamento/concluido)
  const preservedStatuses =
    params.mode === "append"
      ? ["pendente", "em_andamento", "concluido"]
      : ["em_andamento", "concluido"];
  const preserved = data.assignmentRows.filter(
    (a) => a.type === assignmentType && preservedStatuses.includes(a.status)
  );

  // Anti-duplicidade de par: continua derivando de `preserved` (dependente do
  // modo) — em replace as pendentes são deletadas na mesma transação do RPC,
  // então o par pode voltar a ser sorteado sem violar UNIQUE(doc, user, type).
  const preservedSet = new Set(preserved.map((a) => `${a.document_id}:${a.user_id}`));

  // O trigger enforce_comparison_assignment_actor (20260716160100) rejeita
  // comparação atribuída a quem tem resposta humana is_latest no documento, e
  // apply_lottery_assignments é uma transação única: um único par
  // codificador×próprio-doc abortaria o LOTE inteiro com 23514. O caminho
  // automático já exclui codificadores (loadEligibleReviewerIds); aqui o
  // mesmo invariante entra como par vetado do sorteio manual — veto de par,
  // não de vaga: o codificador continua elegível para outros documentos.
  if (assignmentType === "comparacao") {
    for (const row of data.humanCoderRows) {
      preservedSet.add(`${row.document_id}:${row.respondent_id}`);
    }
  }

  // Ocupação de vaga ≠ anti-duplicidade de par. Para comparação a vaga só é
  // ocupada por uma atribuição ATIVA: o invariante é "no máximo 1 comparação
  // ativa por documento" (o mesmo do guard do gatilho automático e do índice
  // assignments_one_active_comparacao_per_doc), não "1 comparação na história do
  // documento". Sem isto, com um revisor por doc, um documento com parecer
  // concluído jamais voltaria ao sorteio — impedindo a re-rodada por versão de
  // schema que o índice existe para permitir. Para codificação, `occupying` é o
  // próprio `preserved`: comportamento idêntico ao anterior (duas codificações
  // concluídas seguem ocupando o documento).
  const occupying =
    assignmentType === "comparacao"
      ? preserved.filter((a) => a.status !== "concluido")
      : preserved;

  const docAssignedCount: Record<string, number> = {};
  const docAssignedUsers: Record<string, Set<string>> = {};
  for (const a of occupying) {
    docAssignedCount[a.document_id] = (docAssignedCount[a.document_id] || 0) + 1;
    (docAssignedUsers[a.document_id] ??= new Set()).add(a.user_id);
  }

  // Carga acumulada segue em `preserved`: uma comparação concluída é trabalho
  // feito — conta para o equilíbrio `history` e é o "existing" da prévia, ainda
  // que não ocupe mais a vaga do documento.
  const preservedByUser: Record<string, number> = {};
  for (const a of preserved) {
    preservedByUser[a.user_id] = (preservedByUser[a.user_id] || 0) + 1;
  }

  // Toda a aleatoriedade deriva do PRNG seedado (research D13)
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = createRng(seed);

  // Docs com vaga, considerando o conjunto preservado do modo
  let eligibleDocIds = filteredDocs
    .filter((d) => (docAssignedCount[d.id] || 0) < researchersPerDoc)
    .map((d) => d.id);
  const eligibleCount = eligibleDocIds.length;

  if (params.docSubsetSize && params.docSubsetSize < eligibleDocIds.length) {
    eligibleDocIds = shuffleWithRng(eligibleDocIds, rng).slice(0, params.docSubsetSize);
  }

  // Matriz de co-ocorrência a partir do conjunto preservado
  const coOccurrence: Record<string, Record<string, number>> = {};
  for (const pId of participantIds) {
    coOccurrence[pId] = {};
    for (const pId2 of participantIds) {
      coOccurrence[pId][pId2] = 0;
    }
  }
  for (const users of Object.values(docAssignedUsers)) {
    if (users.size < 2) continue;
    const userArr = Array.from(users);
    for (let i = 0; i < userArr.length; i++) {
      for (let j = i + 1; j < userArr.length; j++) {
        if (coOccurrence[userArr[i]]) coOccurrence[userArr[i]][userArr[j]] = (coOccurrence[userArr[i]][userArr[j]] || 0) + 1;
        if (coOccurrence[userArr[j]]) coOccurrence[userArr[j]][userArr[i]] = (coOccurrence[userArr[j]][userArr[i]] || 0) + 1;
      }
    }
  }

  // Carga acumulada (conjunto preservado do modo) + capacidade + peso.
  // capacity é o teto de docs NOVOS: o limite individual (cap, teto direto de
  // novos) compõe com o global docsPerResearcher (teto total) — vence o menor
  // (ver computeCapacity). O peso escala a chave de distribuição (load/weight).
  const settings = params.participantSettings ?? {};
  const participants: LotteryParticipant[] = participantIds.map((pId) => {
    const accumulatedLoad = preservedByUser[pId] || 0;
    const cfg = settings[pId] ?? {};
    return {
      id: pId,
      accumulatedLoad,
      capacity: computeCapacity({
        accumulatedLoad,
        docsPerResearcher: params.docsPerResearcher,
        cap: cfg.cap,
      }),
      weight: resolveWeight(cfg.weight),
    };
  });

  const newAssignments: LotteryAssignment[] = distributeDocs(
    eligibleDocIds,
    participants,
    {
      researchersPerDoc,
      balancing: params.balancing,
      preservedPairs: preservedSet,
      docAssignedUsers: Object.fromEntries(
        Object.entries(docAssignedUsers).map(([docId, users]) => [
          docId,
          Array.from(users),
        ])
      ),
      coOccurrence,
      rng,
    }
  );

  const batchData = {
    project_id: params.projectId,
    // O lote registra o que aconteceu (o efetivo), não o que foi pedido.
    researchers_per_doc: researchersPerDoc,
    docs_per_researcher: params.docsPerResearcher || null,
    doc_subset_size: params.docSubsetSize || null,
    label: params.label || null,
    mode: params.mode,
    balancing: params.balancing,
    filters: {
      ...filters,
      participantIds,
      participantSettings: settings,
      docSubsetSize: params.docSubsetSize ?? null,
      seed,
    },
  };

  return {
    newAssignments,
    preservedCount: preserved.length,
    preservedByUser,
    eligibleCount,
    seed,
    batchData,
    assignmentType,
  };
}

export async function previewLottery(
  params: LotteryParams,
): Promise<{ preview?: LotteryPreview; error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  try {
    const { newAssignments, preservedCount, preservedByUser, eligibleCount, seed } =
      await computeLottery(params);

    const newCounts: Record<string, number> = {};
    for (const a of newAssignments) {
      newCounts[a.user_id] = (newCounts[a.user_id] || 0) + 1;
    }

    return {
      preview: {
        participants: [...new Set(params.participantIds)].map((userId) => ({
          userId,
          existing: preservedByUser[userId] || 0,
          newDocs: newCounts[userId] || 0,
        })),
        totalNew: newAssignments.length,
        totalPreserved: preservedCount,
        eligibleDocs: eligibleCount,
        seed,
      },
    };
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao calcular a prévia" };
  }
}

export async function smartRandomize(
  params: LotteryParams,
): Promise<{ count?: number; preserved?: number; error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  let count: number;
  let preserved: number;

  // Operação crítica: computeLottery + registro do lote + RPC transacional. Só
  // um erro aqui (nada gravado, ou gravação abortada) deve virar { error }.
  try {
    const { newAssignments, preservedCount, batchData, assignmentType } =
      await computeLottery(params);

    // O batch é criado antes de qualquer mudança em assignments: se falhar
    // (ex.: migration ausente), nada foi deletado ainda
    const { data: batch, error: batchError } = await supabase
      .from("assignment_batches")
      .insert({ ...batchData, created_by: user.id })
      .select("id")
      .single();

    if (batchError || !batch) {
      throw new Error(
        `Erro ao registrar o lote do sorteio: ${batchError?.message ?? "resposta vazia"}`
      );
    }

    // Descarte das pendentes (modo substituir) + gravação das novas numa
    // transação única via RPC (issue #181): uma falha entre o delete e o insert
    // não perde mais as pendentes. SECURITY INVOKER — a RLS do coordenador vale
    // dentro da função. Dispensa o chunk de 100 (era limite de payload PostgREST).
    const assignmentRows = newAssignments.map((a) => ({
      document_id: a.document_id,
      user_id: a.user_id,
    }));
    const { data: inserted, error: rpcError } = await supabase.rpc(
      "apply_lottery_assignments",
      {
        p_project_id: params.projectId,
        p_type: assignmentType,
        p_batch_id: batch.id,
        p_assignments: assignmentRows,
        p_replace: params.mode === "replace",
      },
    );
    if (rpcError) {
      throw new Error(`Erro ao gravar as atribuições do sorteio: ${rpcError.message}`);
    }

    // Contagem REAL do RPC, não o tamanho do que se pretendia gravar: o
    // ON CONFLICT DO NOTHING pula linhas quando o gatilho automático cria a
    // comparação do documento entre a leitura do computeLottery (fora da
    // transação) e este INSERT. Reportar o pretendido faria o coordenador ver
    // um número que não está no banco.
    count = typeof inserted === "number" ? inserted : newAssignments.length;
    preserved = preservedCount;
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao sortear" };
  }

  // Pós-commit best-effort: as atribuições já foram gravadas pelo RPC. Uma falha
  // daqui pra baixo NÃO pode virar { error } — reportar levaria o coordenador a
  // re-sortear em modo "replace" e reescrever o que já foi gravado com sucesso.
  try {
    // Persiste o peso/limite usado por participante (decisão: editar no diálogo,
    // mas assumir continuidade no próximo sorteio). Uma falha aqui só afeta o
    // default da próxima vez.
    const settingsEntries = Object.entries(params.participantSettings ?? {});
    if (settingsEntries.length > 0) {
      const results = await Promise.all(
        settingsEntries.map(([userId, cfg]) =>
          supabase
            .from("project_members")
            .update({
              assignment_weight: resolveWeight(cfg.weight),
              assignment_cap: resolveCap(cfg.cap),
            })
            .eq("project_id", params.projectId)
            .eq("user_id", userId),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) {
        console.error(
          `[lottery] falha ao persistir peso/limite por membro: ${failed.error.message}`,
        );
      }
      revalidateTag(membersTag(params.projectId), MEMBERS_TAG_PROFILE);
    }

    revalidatePath(`/projects/${params.projectId}/analyze/assignments`);
    revalidatePath(`/projects/${params.projectId}/analyze/code`);
    revalidatePath(`/projects/${params.projectId}/analyze/compare`);
  } catch (e) {
    console.error(`[lottery] falha nos efeitos pós-sorteio: ${errorMessage(e)}`);
  }

  return { count, preserved };
}
