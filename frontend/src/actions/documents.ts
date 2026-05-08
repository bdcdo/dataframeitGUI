"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, isProjectCoordinator } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";

const TAG_PROFILE = { expire: 300 };
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
  documents: { external_id?: string; text_hash: string; csvIndex?: number }[]
): Promise<{
  duplicates: DuplicateMatch[];
  duplicatesWithResponses: number;
}> {
  const supabase = await createSupabaseServer();

  // Hash is computed client-side to keep payload small (Vercel ~4.5MB limit).
  // csvIndex maps back to the full CSV array when caller chunks the check.
  const hashes = documents.map((d) => d.text_hash);
  const indexFor = (i: number) => documents[i].csvIndex ?? i;

  // Collect external_ids that are present
  const externalIds = documents
    .map((d, i) => ({ id: d.external_id, index: i }))
    .filter((d) => d.id);

  const duplicates: DuplicateMatch[] = [];
  const matchedCsvIndices = new Set<number>();

  // 1. Match by external_id (excluidos sao ignorados — re-upload de doc
  //    excluido por engano cria um novo registro normal)
  if (externalIds.length > 0) {
    const { data: byExtId } = await supabase
      .from("documents")
      .select("id, external_id")
      .eq("project_id", projectId)
      .is("excluded_at", null)
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
            csvIndex: indexFor(index),
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
      .is("excluded_at", null)
      .in("text_hash", uniqueHashes);

    if (byHash) {
      const hashMap = new Map(byHash.map((d) => [d.text_hash, d.id]));
      for (const { hash, index } of unmatchedHashes) {
        const existingId = hashMap.get(hash);
        if (existingId) {
          duplicates.push({
            csvIndex: indexFor(index),
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

    if (revalidate) {
      revalidatePath(`/projects/${projectId}/config/documents`);
      revalidateTag(`project-${projectId}-documents`, TAG_PROFILE);
    }
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

    // Batch update duplicate documents (avoid N+1)
    if (duplicateMap.length > 0) {
      await Promise.all(
        duplicateMap.map((dup) => {
          const doc = documents[dup.csvIndex];
          return supabase
            .from("documents")
            .update({
              text: doc.text,
              title: doc.title || null,
              external_id: doc.external_id || null,
              text_hash: md5(doc.text),
              metadata: doc.metadata || null,
            })
            .eq("id", dup.existingDocId);
        })
      );
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

    if (revalidate) {
      revalidatePath(`/projects/${projectId}/config/documents`);
      revalidateTag(`project-${projectId}-documents`, TAG_PROFILE);
    }
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

  if (revalidate) {
      revalidatePath(`/projects/${projectId}/config/documents`);
      revalidateTag(`project-${projectId}-documents`, TAG_PROFILE);
    }
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
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();

  const { data: docs } = await supabase
    .from("documents")
    .select("id, external_id, title, created_at")
    .eq("project_id", projectId)
    .is("excluded_at", null)
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
): Promise<{ document: { id: string; external_id: string | null; title: string | null; text: string }; existingAnswers: Record<string, unknown> | null; existingJustifications: Record<string, unknown> | null }> {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();

  const [{ data: doc }, { data: project }] = await Promise.all([
    supabase
      .from("documents")
      .select("id, external_id, title, text")
      .eq("id", documentId)
      .eq("project_id", projectId)
      .is("excluded_at", null)
      .single(),
    supabase
      .from("projects")
      .select("pydantic_fields")
      .eq("id", projectId)
      .single(),
  ]);

  if (!doc) throw new Error("Documento não encontrado");

  const { data: response } = await supabase
    .from("responses")
    .select("answers, justifications")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("respondent_id", user.id)
    .eq("respondent_type", "humano")
    .single();

  const rawAnswers = (response?.answers as Record<string, unknown>) ?? null;

  // Sanitize answers against current schema options
  if (rawAnswers && project?.pydantic_fields) {
    const fields = (project.pydantic_fields as { name: string; type: string; options: string[] | null; target?: string }[])
      .filter((f) => f.target !== "llm_only" && f.target !== "none");
    const clean: Record<string, unknown> = {};
    for (const field of fields) {
      const val = rawAnswers[field.name];
      if (val === undefined || val === null) continue;
      if (field.type === "single" && field.options) {
        if (field.options.includes(val as string)) clean[field.name] = val;
      } else if (field.type === "multi" && field.options) {
        const arr = Array.isArray(val) ? val.filter((v: string) => field.options!.includes(v)) : [];
        if (arr.length > 0) clean[field.name] = arr;
      } else {
        clean[field.name] = val;
      }
    }
    return { document: doc, existingAnswers: clean, existingJustifications: (response?.justifications as Record<string, unknown>) ?? null };
  }

  return { document: doc, existingAnswers: rawAnswers, existingJustifications: (response?.justifications as Record<string, unknown>) ?? null };
}

export async function getDocumentText(
  projectId: string,
  documentId: string,
): Promise<{ text: string; title: string } | null> {
  const supabase = await createSupabaseServer();
  const { data } = await supabase
    .from("documents")
    .select("title, text")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .single();
  if (!data) return null;
  return { text: data.text, title: data.title || documentId };
}

// Soft delete: marca documents.excluded_at. Reads default filtram excluidos.
// Coordenador pode visualizar/restaurar via toggle "Mostrar excluidos".
export async function excludeDocuments(
  projectId: string,
  documentIds: string[],
  reason: string,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };
  if (!reason?.trim()) return { error: "Motivo da exclusão é obrigatório" };

  const supabase = await createSupabaseServer();

  if (!(await isProjectCoordinator(supabase, projectId, user))) {
    return { error: "Apenas coordenador pode excluir documentos" };
  }

  const { error } = await supabase
    .from("documents")
    .update({
      excluded_at: new Date().toISOString(),
      excluded_reason: reason.trim(),
      excluded_by: user.id,
    })
    .eq("project_id", projectId)
    .in("id", documentIds);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/config/documents`);
  revalidateTag(`project-${projectId}-documents`, TAG_PROFILE);
  return { count: documentIds.length };
}

export async function restoreDocuments(
  projectId: string,
  documentIds: string[],
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  if (!(await isProjectCoordinator(supabase, projectId, user))) {
    return { error: "Apenas coordenador pode restaurar documentos" };
  }

  const { error } = await supabase
    .from("documents")
    .update({
      excluded_at: null,
      excluded_reason: null,
      excluded_by: null,
    })
    .eq("project_id", projectId)
    .in("id", documentIds);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/config/documents`);
  revalidateTag(`project-${projectId}-documents`, TAG_PROFILE);
  return { count: documentIds.length };
}

// Hard delete: remove DB permanente (CASCADE em responses/reviews/assignments).
// So usar quando coordenador confirma que o doc nao deve voltar nem manter
// historico — tipicamente apos soft delete + revisao.
export async function hardDeleteDocuments(
  projectId: string,
  documentIds: string[],
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  if (!(await isProjectCoordinator(supabase, projectId, user))) {
    return { error: "Apenas coordenador pode apagar documentos permanentemente" };
  }

  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("project_id", projectId)
    .in("id", documentIds);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/config/documents`);
  revalidateTag(`project-${projectId}-documents`, TAG_PROFILE);
  return { count: documentIds.length };
}
