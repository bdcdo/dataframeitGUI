"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import {
  createRng,
  distributeDocs,
  filterEligibleDocs,
  shuffleWithRng,
  type LotteryBalancing,
  type LotteryDocStats,
  type LotteryFilters,
  type LotteryMode,
  type LotteryParticipant,
} from "@/lib/lottery-utils";

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
) {
  const supabase = await createSupabaseServer();

  const { data: existing } = await supabase
    .from("assignments")
    .select("id, status, type")
    .eq("document_id", documentId)
    .eq("user_id", userId);

  const rows = existing || [];

  // Bloquear ciclo se houver assignment não-pendente de qualquer tipo
  const hasNonPending = rows.some((r) => r.status !== "pendente");
  if (hasNonPending) return;

  const pendingCod = rows.find((r) => r.type === "codificacao");
  const pendingComp = rows.find((r) => r.type === "comparacao");

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

  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
}

export async function clearPendingAssignments(
  projectId: string,
  type: "codificacao" | "comparacao" = "codificacao"
) {
  const supabase = await createSupabaseServer();

  const { count } = await supabase
    .from("assignments")
    .delete({ count: "exact" })
    .eq("project_id", projectId)
    .eq("status", "pendente")
    .eq("type", type);

  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  return { deleted: count ?? 0 };
}

// --- Smart Lottery (spec 001) ---

export interface LotteryParams {
  projectId: string;
  type?: "codificacao" | "comparacao";
  mode: LotteryMode;
  balancing: LotteryBalancing;
  /** semente da prévia (research D13); ausente = gerar nova */
  seed?: number;
  researchersPerDoc: number;
  docsPerResearcher?: number;
  docSubsetSize?: number;
  label?: string;
  filters?: LotteryFilters;
  participantIds: string[];
}

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

interface LotteryData {
  docs: LotteryDocStats[];
  batches: { id: string; label: string | null; createdAt: string }[];
  minResponsesForComparison: number;
  assignmentRows: {
    document_id: string;
    user_id: string;
    status: string;
    type: string;
  }[];
}

async function fetchLotteryData(projectId: string): Promise<LotteryData> {
  const supabase = await createSupabaseServer();

  const [{ data: docs }, { data: responses }, { data: assignments }, { data: batches }, { data: project }] =
    await Promise.all([
      supabase
        .from("documents")
        .select("id, external_id, title")
        .eq("project_id", projectId)
        .is("excluded_at", null),
      supabase
        .from("responses")
        .select("document_id, respondent_id")
        .eq("project_id", projectId)
        .eq("is_latest", true)
        .eq("respondent_type", "humano"),
      supabase
        .from("assignments")
        .select("document_id, user_id, status, type, batch_id")
        .eq("project_id", projectId),
      supabase
        .from("assignment_batches")
        .select("id, label, created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }),
      supabase
        .from("projects")
        .select("min_responses_for_comparison")
        .eq("id", projectId)
        .single(),
    ]);

  const respondentsByDoc: Record<string, Set<string>> = {};
  for (const r of responses || []) {
    (respondentsByDoc[r.document_id] ??= new Set()).add(r.respondent_id);
  }

  const activeByDoc: Record<string, { codificacao: number; comparacao: number }> = {};
  const everAssigned = new Set<string>();
  const batchIdsByDoc: Record<string, Set<string>> = {};
  for (const a of assignments || []) {
    everAssigned.add(a.document_id);
    if (a.batch_id) (batchIdsByDoc[a.document_id] ??= new Set()).add(a.batch_id);
    if (
      (a.type === "codificacao" || a.type === "comparacao") &&
      (a.status === "pendente" || a.status === "em_andamento")
    ) {
      const counts = (activeByDoc[a.document_id] ??= { codificacao: 0, comparacao: 0 });
      counts[a.type as "codificacao" | "comparacao"]++;
    }
  }

  return {
    docs: (docs || []).map((d) => ({
      id: d.id,
      externalId: d.external_id,
      title: d.title,
      humanCodingCount: respondentsByDoc[d.id]?.size || 0,
      activeAssignments: activeByDoc[d.id] || { codificacao: 0, comparacao: 0 },
      hasAnyAssignmentEver: everAssigned.has(d.id),
      batchIds: Array.from(batchIdsByDoc[d.id] || []),
    })),
    batches: (batches || []).map((b) => ({
      id: b.id,
      label: b.label,
      createdAt: b.created_at,
    })),
    minResponsesForComparison: project?.min_responses_for_comparison || 2,
    assignmentRows: (assignments || []).map((a) => ({
      document_id: a.document_id,
      user_id: a.user_id,
      status: a.status,
      type: a.type,
    })),
  };
}

/**
 * Stats leves por documento, carregadas uma vez na abertura do dialog.
 * O client reaplica filterEligibleDocs sobre elas para contagem ao vivo.
 */
export async function getLotteryDocStats(projectId: string): Promise<{
  docs: LotteryDocStats[];
  batches: { id: string; label: string | null; createdAt: string }[];
  minResponsesForComparison: number;
}> {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const { docs, batches, minResponsesForComparison } = await fetchLotteryData(projectId);
  return { docs, batches, minResponsesForComparison };
}

async function computeLottery(params: LotteryParams): Promise<{
  newAssignments: LotteryAssignment[];
  preservedCount: number;
  preservedByUser: Record<string, number>;
  eligibleCount: number;
  seed: number;
  batchData: Record<string, unknown>;
}> {
  const supabase = await createSupabaseServer();
  const assignmentType = params.type || "codificacao";
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

  // Pool de participantes: explícito e validado contra project_members
  // (qualquer role) — defesa em profundidade além do RLS (research D5)
  const memberIds = new Set((members || []).map((m) => m.user_id));
  const participantIds = params.participantIds.filter((id) => memberIds.has(id));
  if (!participantIds.length || participantIds.length !== params.participantIds.length) {
    throw new Error("Necessário ter ao menos um participante válido.");
  }

  if (!data.docs.length) {
    throw new Error("Necessário ter documentos.");
  }

  // Exigência mínima de respostas para comparação — compõe com os filtros
  let candidateDocs = data.docs;
  if (assignmentType === "comparacao") {
    candidateDocs = candidateDocs.filter(
      (d) => d.humanCodingCount >= data.minResponsesForComparison
    );
    if (!candidateDocs.length) {
      throw new Error("Nenhum documento tem respostas suficientes para comparação.");
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

  const preservedSet = new Set(preserved.map((a) => `${a.document_id}:${a.user_id}`));

  const docAssignedCount: Record<string, number> = {};
  const docAssignedUsers: Record<string, Set<string>> = {};
  const preservedByUser: Record<string, number> = {};
  for (const a of preserved) {
    docAssignedCount[a.document_id] = (docAssignedCount[a.document_id] || 0) + 1;
    (docAssignedUsers[a.document_id] ??= new Set()).add(a.user_id);
    preservedByUser[a.user_id] = (preservedByUser[a.user_id] || 0) + 1;
  }

  // Toda a aleatoriedade deriva do PRNG seedado (research D13)
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = createRng(seed);

  // Docs com vaga, considerando o conjunto preservado do modo
  let eligibleDocIds = filteredDocs
    .filter((d) => (docAssignedCount[d.id] || 0) < params.researchersPerDoc)
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

  // Carga acumulada (conjunto preservado do modo) + capacidade
  const participants: LotteryParticipant[] = participantIds.map((pId) => {
    const accumulatedLoad = preservedByUser[pId] || 0;
    return {
      id: pId,
      accumulatedLoad,
      capacity: params.docsPerResearcher
        ? Math.max(0, params.docsPerResearcher - accumulatedLoad)
        : Infinity,
    };
  });

  const newAssignments: LotteryAssignment[] = distributeDocs(
    eligibleDocIds,
    participants,
    {
      researchersPerDoc: params.researchersPerDoc,
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
    researchers_per_doc: params.researchersPerDoc,
    docs_per_researcher: params.docsPerResearcher || null,
    doc_subset_size: params.docSubsetSize || null,
    deadline_mode: "none",
    label: params.label || null,
    mode: params.mode,
    balancing: params.balancing,
    filters: {
      ...filters,
      participantIds,
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
  };
}

export async function previewLottery(params: LotteryParams): Promise<LotteryPreview> {
  const { newAssignments, preservedCount, preservedByUser, eligibleCount, seed } =
    await computeLottery(params);

  const newCounts: Record<string, number> = {};
  for (const a of newAssignments) {
    newCounts[a.user_id] = (newCounts[a.user_id] || 0) + 1;
  }

  return {
    participants: params.participantIds.map((userId) => ({
      userId,
      existing: preservedByUser[userId] || 0,
      newDocs: newCounts[userId] || 0,
    })),
    totalNew: newAssignments.length,
    totalPreserved: preservedCount,
    eligibleDocs: eligibleCount,
    seed,
  };
}

export async function smartRandomize(params: LotteryParams) {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();
  const assignmentType = params.type || "codificacao";

  const { newAssignments, preservedCount, batchData } = await computeLottery(params);

  // Pendentes do tipo só são descartadas no modo substituir
  if (params.mode === "replace") {
    await supabase
      .from("assignments")
      .delete()
      .eq("project_id", params.projectId)
      .eq("status", "pendente")
      .eq("type", assignmentType);
  }

  const { data: batch } = await supabase
    .from("assignment_batches")
    .insert({ ...batchData, created_by: user.id })
    .select("id")
    .single();

  const batchId = batch?.id || null;

  const chunkSize = 100;
  for (let i = 0; i < newAssignments.length; i += chunkSize) {
    const chunk = newAssignments.slice(i, i + chunkSize).map((a) => ({
      project_id: params.projectId,
      document_id: a.document_id,
      user_id: a.user_id,
      batch_id: batchId,
      type: assignmentType,
    }));
    await supabase.from("assignments").insert(chunk);
  }

  revalidatePath(`/projects/${params.projectId}/analyze/assignments`);
  revalidatePath(`/projects/${params.projectId}/analyze/code`);
  revalidatePath(`/projects/${params.projectId}/analyze/compare`);
  return { count: newAssignments.length, preserved: preservedCount };
}
