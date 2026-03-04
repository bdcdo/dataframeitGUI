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

export async function randomizeAssignments(
  projectId: string,
  researchersPerDoc: number,
  balance: boolean,
  seed?: number
) {
  const supabase = await createSupabaseServer();

  // Get researchers
  const { data: members } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("role", "pesquisador");

  // Get documents
  const { data: docs } = await supabase
    .from("documents")
    .select("id")
    .eq("project_id", projectId);

  if (!members?.length || !docs?.length) {
    throw new Error("Necessário ter pesquisadores e documentos.");
  }

  const researcherIds = members.map((m) => m.user_id);
  const documentIds = docs.map((d) => d.id);

  // Round-robin assignment
  const rng = seed !== undefined ? seededRandom(seed) : Math.random;
  const shuffledDocs = [...documentIds].sort(() => rng() - 0.5);
  const shuffledResearchers = [...researcherIds].sort(() => rng() - 0.5);

  const assignments: { project_id: string; document_id: string; user_id: string }[] = [];

  for (const docId of shuffledDocs) {
    for (let i = 0; i < Math.min(researchersPerDoc, shuffledResearchers.length); i++) {
      const researcherIdx = (shuffledDocs.indexOf(docId) * researchersPerDoc + i) % shuffledResearchers.length;
      assignments.push({
        project_id: projectId,
        document_id: docId,
        user_id: shuffledResearchers[researcherIdx],
      });
    }
  }

  // Delete existing and insert new
  await supabase.from("assignments").delete().eq("project_id", projectId);

  const chunkSize = 100;
  for (let i = 0; i < assignments.length; i += chunkSize) {
    const chunk = assignments.slice(i, i + chunkSize);
    await supabase.from("assignments").insert(chunk);
  }

  revalidatePath(`/projects/${projectId}/assignments`);
  return { count: assignments.length };
}

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
