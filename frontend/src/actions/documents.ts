"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

interface DocumentRow {
  external_id?: string;
  title?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export async function uploadDocuments(
  projectId: string,
  documents: DocumentRow[],
  revalidate: boolean = true
) {
  const supabase = await createSupabaseServer();

  const rows = documents.map((doc) => ({
    project_id: projectId,
    external_id: doc.external_id || null,
    title: doc.title || null,
    text: doc.text,
    metadata: doc.metadata || null,
  }));

  const { error } = await supabase.from("documents").insert(rows);
  if (error) return { error: error.message };

  if (revalidate) revalidatePath(`/projects/${projectId}/documents`);
  return { count: rows.length };
}

export interface BrowseDocument {
  id: string;
  external_id: string | null;
  title: string | null;
  created_at: string;
  responseCount: number;
  userAlreadyResponded: boolean;
}

export async function getDocumentsForBrowse(projectId: string): Promise<BrowseDocument[]> {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: docs } = await supabase
    .from("documents")
    .select("id, external_id, title, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  if (!docs || docs.length === 0) return [];

  // Get human response counts
  const { data: responses } = await supabase
    .from("responses")
    .select("document_id, respondent_id")
    .eq("project_id", projectId)
    .eq("respondent_type", "humano");

  const countMap = new Map<string, Set<string>>();
  const userRespondedSet = new Set<string>();

  responses?.forEach((r) => {
    if (!countMap.has(r.document_id)) countMap.set(r.document_id, new Set());
    countMap.get(r.document_id)!.add(r.respondent_id);
    if (r.respondent_id === user.id) userRespondedSet.add(r.document_id);
  });

  return docs.map((d) => ({
    id: d.id,
    external_id: d.external_id,
    title: d.title,
    created_at: d.created_at,
    responseCount: countMap.get(d.id)?.size ?? 0,
    userAlreadyResponded: userRespondedSet.has(d.id),
  }));
}

export async function getDocumentForCoding(
  projectId: string,
  documentId: string
): Promise<{ document: { id: string; external_id: string | null; title: string | null; text: string }; existingAnswers: Record<string, unknown> | null }> {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: doc } = await supabase
    .from("documents")
    .select("id, external_id, title, text")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .single();

  if (!doc) throw new Error("Document not found");

  const { data: response } = await supabase
    .from("responses")
    .select("answers")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("respondent_id", user.id)
    .eq("respondent_type", "humano")
    .single();

  return {
    document: doc,
    existingAnswers: (response?.answers as Record<string, unknown>) ?? null,
  };
}

export async function deleteDocument(projectId: string, documentId: string) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/documents`);
}
