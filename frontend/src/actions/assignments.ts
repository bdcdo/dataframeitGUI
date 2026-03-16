"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function toggleAssignment(
  projectId: string,
  documentId: string,
  userId: string
) {
  const supabase = await createSupabaseServer();

  // Check if assignment exists
  const { data: existing } = await supabase
    .from("assignments")
    .select("id")
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .single();

  if (existing) {
    await supabase.from("assignments").delete().eq("id", existing.id);
  } else {
    await supabase.from("assignments").insert({
      project_id: projectId,
      document_id: documentId,
      user_id: userId,
    });
  }

  revalidatePath(`/projects/${projectId}/assignments`);
}

// --- Smart Lottery ---

export interface LotteryParams {
  projectId: string;
  researchersPerDoc: number;
  docsPerResearcher?: number;
  docSubsetSize?: number;
  deadlineMode: "none" | "batch" | "recurring";
  deadlineDate?: string;
  recurringCount?: number;
  recurringStart?: string;
  label?: string;
}

interface LotteryAssignment {
  document_id: string;
  user_id: string;
  deadline: string | null;
}

export interface LotteryPreview {
  researchers: {
    userId: string;
    existing: number;
    newDocs: number;
    deadline: string | null;
  }[];
  totalNew: number;
  totalPreserved: number;
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function computeLottery(
  params: LotteryParams
): Promise<{ newAssignments: LotteryAssignment[]; preserved: number; batchData: Record<string, unknown> }> {
  const supabase = await createSupabaseServer();

  // 1. Fetch researchers
  const { data: members } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", params.projectId)
    .eq("role", "pesquisador");

  // 2. Fetch documents
  const { data: docs } = await supabase
    .from("documents")
    .select("id")
    .eq("project_id", params.projectId);

  if (!members?.length || !docs?.length) {
    throw new Error("Necessário ter pesquisadores e documentos.");
  }

  const researcherIds = members.map((m) => m.user_id);
  const documentIds = docs.map((d) => d.id);

  // 3. Fetch existing non-pending assignments (preserve these)
  const { data: existingAssignments } = await supabase
    .from("assignments")
    .select("id, document_id, user_id, status")
    .eq("project_id", params.projectId)
    .in("status", ["em_andamento", "concluido"]);

  const preserved = existingAssignments || [];

  // Build sets for quick lookup
  const preservedSet = new Set(preserved.map((a) => `${a.document_id}:${a.user_id}`));

  // 4. Count existing non-pending per doc
  const docAssignedCount: Record<string, number> = {};
  const docAssignedUsers: Record<string, Set<string>> = {};
  for (const a of preserved) {
    docAssignedCount[a.document_id] = (docAssignedCount[a.document_id] || 0) + 1;
    if (!docAssignedUsers[a.document_id]) docAssignedUsers[a.document_id] = new Set();
    docAssignedUsers[a.document_id].add(a.user_id);
  }

  // 5. Count existing per researcher
  const researcherAssignedCount: Record<string, number> = {};
  for (const a of preserved) {
    researcherAssignedCount[a.user_id] = (researcherAssignedCount[a.user_id] || 0) + 1;
  }

  // 6. Determine which docs need more researchers
  let eligibleDocs = documentIds.filter((docId) => {
    const current = docAssignedCount[docId] || 0;
    return current < params.researchersPerDoc;
  });

  // 7. Subset: if docSubsetSize defined, pick random subset
  if (params.docSubsetSize && params.docSubsetSize < eligibleDocs.length) {
    eligibleDocs = shuffleArray(eligibleDocs).slice(0, params.docSubsetSize);
  }

  // 8. Build co-occurrence matrix for pair variation
  const coOccurrence: Record<string, Record<string, number>> = {};
  for (const rId of researcherIds) {
    coOccurrence[rId] = {};
    for (const rId2 of researcherIds) {
      coOccurrence[rId][rId2] = 0;
    }
  }
  // Count from preserved
  for (const docId of documentIds) {
    const users = docAssignedUsers[docId];
    if (!users || users.size < 2) continue;
    const userArr = Array.from(users);
    for (let i = 0; i < userArr.length; i++) {
      for (let j = i + 1; j < userArr.length; j++) {
        if (coOccurrence[userArr[i]]) coOccurrence[userArr[i]][userArr[j]] = (coOccurrence[userArr[i]][userArr[j]] || 0) + 1;
        if (coOccurrence[userArr[j]]) coOccurrence[userArr[j]][userArr[i]] = (coOccurrence[userArr[j]][userArr[i]] || 0) + 1;
      }
    }
  }

  // 9. Capacity per researcher
  const capacity: Record<string, number> = {};
  for (const rId of researcherIds) {
    if (params.docsPerResearcher) {
      capacity[rId] = Math.max(0, params.docsPerResearcher - (researcherAssignedCount[rId] || 0));
    } else {
      capacity[rId] = Infinity;
    }
  }

  // 10. Distribute with pair variation
  const newAssignments: LotteryAssignment[] = [];
  const newDocUsers: Record<string, string[]> = {};

  // Shuffle eligible docs for randomness
  const shuffledEligible = shuffleArray(eligibleDocs);

  for (const docId of shuffledEligible) {
    const currentUsers = docAssignedUsers[docId] || new Set<string>();
    const need = params.researchersPerDoc - currentUsers.size;
    if (need <= 0) continue;

    // Candidates: researchers not already assigned to this doc, with capacity
    const candidates = researcherIds.filter(
      (rId) => !currentUsers.has(rId) && !preservedSet.has(`${docId}:${rId}`) && capacity[rId] > 0
    );

    // Sort by: lowest co-occurrence with already assigned, then most remaining capacity
    const alreadyOnDoc = [...Array.from(currentUsers), ...(newDocUsers[docId] || [])];

    const scored = candidates.map((rId) => {
      const coScore = alreadyOnDoc.reduce((sum, uid) => sum + (coOccurrence[rId]?.[uid] || 0), 0);
      return { rId, coScore, cap: capacity[rId] === Infinity ? 999999 : capacity[rId] };
    });

    scored.sort((a, b) => a.coScore - b.coScore || b.cap - a.cap);

    const chosen = scored.slice(0, need);
    if (!newDocUsers[docId]) newDocUsers[docId] = [];

    for (const { rId } of chosen) {
      newAssignments.push({ document_id: docId, user_id: rId, deadline: null });
      capacity[rId]--;
      newDocUsers[docId].push(rId);

      // Update co-occurrence
      for (const uid of [...alreadyOnDoc, ...newDocUsers[docId]]) {
        if (uid !== rId) {
          if (coOccurrence[rId]) coOccurrence[rId][uid] = (coOccurrence[rId][uid] || 0) + 1;
          if (coOccurrence[uid]) coOccurrence[uid][rId] = (coOccurrence[uid][rId] || 0) + 1;
        }
      }
    }
  }

  // 11. Calculate deadlines
  if (params.deadlineMode === "batch" && params.deadlineDate) {
    for (const a of newAssignments) {
      a.deadline = params.deadlineDate;
    }
  } else if (params.deadlineMode === "recurring" && params.recurringCount && params.recurringStart) {
    // Group by researcher, assign weekly batches
    const byResearcher: Record<string, LotteryAssignment[]> = {};
    for (const a of newAssignments) {
      if (!byResearcher[a.user_id]) byResearcher[a.user_id] = [];
      byResearcher[a.user_id].push(a);
    }

    for (const assignments of Object.values(byResearcher)) {
      const startDate = new Date(params.recurringStart);
      let weekOffset = 0;
      for (let i = 0; i < assignments.length; i += params.recurringCount) {
        weekOffset++;
        const deadline = new Date(startDate);
        deadline.setDate(deadline.getDate() + weekOffset * 7);
        const deadlineStr = deadline.toISOString().split("T")[0];
        for (let j = i; j < Math.min(i + params.recurringCount, assignments.length); j++) {
          assignments[j].deadline = deadlineStr;
        }
      }
    }
  }

  const batchData = {
    project_id: params.projectId,
    researchers_per_doc: params.researchersPerDoc,
    docs_per_researcher: params.docsPerResearcher || null,
    doc_subset_size: params.docSubsetSize || null,
    deadline_mode: params.deadlineMode,
    deadline_date: params.deadlineDate || null,
    recurring_count: params.recurringCount || null,
    recurring_start: params.recurringStart || null,
    label: params.label || null,
  };

  return { newAssignments, preserved: preserved.length, batchData };
}

export async function previewLottery(params: LotteryParams): Promise<LotteryPreview> {
  const { newAssignments, preserved } = await computeLottery(params);

  const supabase = await createSupabaseServer();

  // Get existing non-pending counts per researcher
  const { data: existingAssignments } = await supabase
    .from("assignments")
    .select("user_id, status")
    .eq("project_id", params.projectId)
    .in("status", ["em_andamento", "concluido"]);

  const existingCounts: Record<string, number> = {};
  for (const a of existingAssignments || []) {
    existingCounts[a.user_id] = (existingCounts[a.user_id] || 0) + 1;
  }

  // Count new per researcher
  const newCounts: Record<string, number> = {};
  const lastDeadline: Record<string, string | null> = {};
  for (const a of newAssignments) {
    newCounts[a.user_id] = (newCounts[a.user_id] || 0) + 1;
    if (a.deadline) lastDeadline[a.user_id] = a.deadline;
  }

  // Get all researcher IDs
  const { data: members } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", params.projectId)
    .eq("role", "pesquisador");

  const researchers = (members || []).map((m) => ({
    userId: m.user_id,
    existing: existingCounts[m.user_id] || 0,
    newDocs: newCounts[m.user_id] || 0,
    deadline: lastDeadline[m.user_id] || null,
  }));

  return {
    researchers,
    totalNew: newAssignments.length,
    totalPreserved: preserved,
  };
}

export async function smartRandomize(params: LotteryParams) {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { newAssignments, preserved, batchData } = await computeLottery(params);

  // Delete only pending assignments
  await supabase
    .from("assignments")
    .delete()
    .eq("project_id", params.projectId)
    .eq("status", "pendente");

  // Create batch record
  const { data: batch } = await supabase
    .from("assignment_batches")
    .insert({ ...batchData, created_by: user.id })
    .select("id")
    .single();

  const batchId = batch?.id || null;

  // Insert new assignments in chunks
  const chunkSize = 100;
  for (let i = 0; i < newAssignments.length; i += chunkSize) {
    const chunk = newAssignments.slice(i, i + chunkSize).map((a) => ({
      project_id: params.projectId,
      document_id: a.document_id,
      user_id: a.user_id,
      deadline: a.deadline,
      batch_id: batchId,
    }));
    await supabase.from("assignments").insert(chunk);
  }

  revalidatePath(`/projects/${params.projectId}/assignments`);
  return { count: newAssignments.length, preserved };
}

// Keep legacy for backward compat (redirects to smart)
export async function randomizeAssignments(
  projectId: string,
  researchersPerDoc: number,
  _balance: boolean,
  _seed?: number
) {
  return smartRandomize({
    projectId,
    researchersPerDoc,
    deadlineMode: "none",
  });
}
