"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { createHash } from "crypto";

interface DocumentRow {
  external_id?: string;
  title?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

export interface DuplicateMatch {
  csvIndex: number;
  existingDocId: string;
  matchType: "external_id" | "text_hash";
}

export async function checkDuplicates(
  projectId: string,
  documents: { external_id?: string; text: string }[]
): Promise<{
  duplicates: DuplicateMatch[];
  duplicatesWithResponses: number;
}> {
  const supabase = await createSupabaseServer();

  // Compute hashes for all incoming docs
  const hashes = documents.map((d) => md5(d.text));

  // Collect external_ids that are present
  const externalIds = documents
    .map((d, i) => ({ id: d.external_id, index: i }))
    .filter((d) => d.id);

  const duplicates: DuplicateMatch[] = [];
  const matchedCsvIndices = new Set<number>();

  // 1. Match by external_id
  if (externalIds.length > 0) {
    const { data: byExtId } = await supabase
      .from("documents")
      .select("id, external_id")
      .eq("project_id", projectId)
      .in(
        "external_id",
        externalIds.map((e) => e.id!)
      );

    if (byExtId) {
      const extIdMap = new Map(byExtId.map((d) => [d.external_id, d.id]));
      for (const { id, index } of externalIds) {
        const existingId = extIdMap.get(id!);
        if (existingId) {
          duplicates.push({
            csvIndex: index,
            existingDocId: existingId,
            matchType: "external_id",
          });
          matchedCsvIndices.add(index);
        }
      }
    }
  }

  // 2. Match remaining by text_hash
  const unmatchedHashes = hashes
    .map((h, i) => ({ hash: h, index: i }))
    .filter((h) => !matchedCsvIndices.has(h.index));

  if (unmatchedHashes.length > 0) {
    const uniqueHashes = [...new Set(unmatchedHashes.map((h) => h.hash))];
    const { data: byHash } = await supabase
      .from("documents")
      .select("id, text_hash")
      .eq("project_id", projectId)
      .in("text_hash", uniqueHashes);

    if (byHash) {
      const hashMap = new Map(byHash.map((d) => [d.text_hash, d.id]));
      for (const { hash, index } of unmatchedHashes) {
        const existingId = hashMap.get(hash);
        if (existingId) {
          duplicates.push({
            csvIndex: index,
            existingDocId: existingId,
            matchType: "text_hash",
          });
        }
      }
    }
  }

  // 3. Count duplicates that have responses
  let duplicatesWithResponses = 0;
  if (duplicates.length > 0) {
    const docIds = duplicates.map((d) => d.existingDocId);
    const { data: responses } = await supabase
      .from("responses")
      .select("document_id")
      .eq("project_id", projectId)
      .in("document_id", docIds);

    if (responses) {
      const docsWithResponses = new Set(responses.map((r) => r.document_id));
      duplicatesWithResponses = docIds.filter((id) =>
        docsWithResponses.has(id)
      ).length;
    }
  }

  return { duplicates, duplicatesWithResponses };
}

export interface UploadOptions {
  mode: "add_all" | "add_new_only" | "replace_and_add";
  duplicateMap?: DuplicateMatch[];
  deleteResponses?: boolean;
}

export async function uploadDocuments(
  projectId: string,
  documents: DocumentRow[],
  revalidate: boolean = true,
  options?: UploadOptions
) {
  const supabase = await createSupabaseServer();
  const mode = options?.mode ?? "add_all";
  const duplicateMap = options?.duplicateMap ?? [];

  const duplicateIndices = new Set(duplicateMap.map((d) => d.csvIndex));

  if (mode === "add_new_only") {
    // Filter out duplicates, only insert new ones
    const newDocs = documents.filter((_, i) => !duplicateIndices.has(i));
    if (newDocs.length === 0) return { count: 0 };

    const rows = newDocs.map((doc) => ({
      project_id: projectId,
      external_id: doc.external_id || null,
      title: doc.title || null,
      text: doc.text,
      text_hash: md5(doc.text),
      metadata: doc.metadata || null,
    }));

    const { error } = await supabase.from("documents").insert(rows);
    if (error) return { error: error.message };

    if (revalidate) revalidatePath(`/projects/${projectId}/documents`);
    return { count: rows.length };
  }

  if (mode === "replace_and_add") {
    // Update existing duplicates + insert new ones
    const existingDocIds = duplicateMap.map((d) => d.existingDocId);

    if (options?.deleteResponses && existingDocIds.length > 0) {
      // Delete reviews first (FK chosen_response_id -> responses without CASCADE)
      await supabase
        .from("reviews")
        .delete()
        .eq("project_id", projectId)
        .in("document_id", existingDocIds);

      // Then delete responses
      await supabase
        .from("responses")
        .delete()
        .eq("project_id", projectId)
        .in("document_id", existingDocIds);

      // Reset assignments to 'pendente'
      await supabase
        .from("assignments")
        .update({ status: "pendente" })
        .eq("project_id", projectId)
        .in("document_id", existingDocIds);
    }

    // Update each duplicate document
    for (const dup of duplicateMap) {
      const doc = documents[dup.csvIndex];
      await supabase
        .from("documents")
        .update({
          text: doc.text,
          title: doc.title || null,
          external_id: doc.external_id || null,
          text_hash: md5(doc.text),
          metadata: doc.metadata || null,
        })
        .eq("id", dup.existingDocId);
    }

    // Insert new (non-duplicate) documents
    const newDocs = documents.filter((_, i) => !duplicateIndices.has(i));
    if (newDocs.length > 0) {
      const rows = newDocs.map((doc) => ({
        project_id: projectId,
        external_id: doc.external_id || null,
        title: doc.title || null,
        text: doc.text,
        text_hash: md5(doc.text),
        metadata: doc.metadata || null,
      }));

      const { error } = await supabase.from("documents").insert(rows);
      if (error) return { error: error.message };
    }

    if (revalidate) revalidatePath(`/projects/${projectId}/documents`);
    return { count: documents.length };
  }

  // Default: add_all — current behavior + compute text_hash
  const rows = documents.map((doc) => ({
    project_id: projectId,
    external_id: doc.external_id || null,
    title: doc.title || null,
    text: doc.text,
    text_hash: md5(doc.text),
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
