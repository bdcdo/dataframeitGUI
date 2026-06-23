"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, isProjectCoordinator } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";

const TAG_PROFILE = Object.freeze({ expire: 300 });
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
  const externalIds = documents.flatMap((d, i) =>
    d.external_id ? [{ id: d.external_id, index: i }] : [],
  );

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
  const unmatchedHashes = hashes.flatMap((h, i) =>
    matchedCsvIndices.has(i) ? [] : [{ hash: h, index: i }],
  );

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

/**
 * Remove as linhas que violariam o indice unico parcial
 * documents_project_external_id_active_uniq — UNIQUE(project_id, external_id)
 * WHERE external_id IS NOT NULL AND excluded_at IS NULL (migration
 * 20260623130000). Dois conflitos possiveis num INSERT em lote, ambos abortariam
 * a operacao inteira (perdendo tambem as linhas novas validas):
 *   1. external_id ja ATIVO no projeto (re-import — a causa raiz das duplicatas);
 *   2. external_id repetido dentro do proprio lote (CSV com linhas duplicadas).
 * Linhas sem external_id nunca sao filtradas (varios docs sem external_id sao
 * validos). Retorna as linhas seguras + contagem do que foi pulado.
 */
async function filterActiveExternalIdConflicts<
  T extends { external_id: string | null },
>(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  projectId: string,
  rows: T[],
): Promise<{ rows: T[]; skippedExisting: number; skippedInBatch: number }> {
  const ids = [
    ...new Set(rows.map((r) => r.external_id).filter((id): id is string => !!id)),
  ];

  const existing = new Set<string>();
  if (ids.length > 0) {
    const { data } = await supabase
      .from("documents")
      .select("external_id")
      .eq("project_id", projectId)
      .is("excluded_at", null)
      .in("external_id", ids);
    for (const d of data ?? []) {
      if (d.external_id) existing.add(d.external_id);
    }
  }

  const seen = new Set<string>();
  let skippedExisting = 0;
  let skippedInBatch = 0;
  const safe = rows.filter((r) => {
    if (!r.external_id) return true;
    if (existing.has(r.external_id)) {
      skippedExisting++;
      return false;
    }
    if (seen.has(r.external_id)) {
      skippedInBatch++;
      return false;
    }
    seen.add(r.external_id);
    return true;
  });

  return { rows: safe, skippedExisting, skippedInBatch };
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
    // Duplicatas descartadas aqui (detectadas pelo duplicateMap) ja contam como
    // ignoradas — mantem a invariante count + skipped == documents.length para
    // o toast reportar o numero correto.
    const skippedDuplicates = documents.length - newDocs.length;
    if (newDocs.length === 0) return { count: 0, skipped: skippedDuplicates };

    const baseRows = newDocs.map((doc) => ({
      project_id: projectId,
      external_id: doc.external_id || null,
      title: doc.title || null,
      text: doc.text,
      text_hash: md5(doc.text),
      metadata: doc.metadata || null,
    }));
    // Defesa extra contra o indice unico: duplicateMap pode estar stale e o
    // proprio lote pode repetir external_id.
    const { rows, skippedExisting, skippedInBatch } =
      await filterActiveExternalIdConflicts(supabase, projectId, baseRows);

    if (rows.length > 0) {
      const { error } = await supabase.from("documents").insert(rows);
      if (error) return { error: error.message };
    }

    if (revalidate) {
      revalidatePath(`/projects/${projectId}/config/documents`);
      revalidateTag(`project-${projectId}-documents`, TAG_PROFILE);
    }
    return {
      count: rows.length,
      skipped: skippedDuplicates + skippedExisting + skippedInBatch,
    };
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
      // Checa o erro de cada update: setar external_id num doc casado por
      // text_hash pode colidir com outro doc ativo e violar o indice unico
      // parcial (23505). Sem isso o erro seria resolvido e ignorado em silencio
      // (o doc nao seria atualizado mas contaria como processado).
      const updateResults = await Promise.all(
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
      const failedUpdate = updateResults.find((r) => r.error);
      if (failedUpdate?.error) return { error: failedUpdate.error.message };
    }

    // Insert new (non-duplicate) documents
    const newDocs = documents.filter((_, i) => !duplicateIndices.has(i));
    let skipped = 0;
    if (newDocs.length > 0) {
      const baseRows = newDocs.map((doc) => ({
        project_id: projectId,
        external_id: doc.external_id || null,
        title: doc.title || null,
        text: doc.text,
        text_hash: md5(doc.text),
        metadata: doc.metadata || null,
      }));
      // Defesa contra o indice unico (duplicateMap stale / repeticao no lote).
      const { rows, skippedExisting, skippedInBatch } =
        await filterActiveExternalIdConflicts(supabase, projectId, baseRows);
      skipped = skippedExisting + skippedInBatch;

      if (rows.length > 0) {
        const { error } = await supabase.from("documents").insert(rows);
        if (error) return { error: error.message };
      }
    }

    if (revalidate) {
      revalidatePath(`/projects/${projectId}/config/documents`);
      revalidateTag(`project-${projectId}-documents`, TAG_PROFILE);
    }
    return { count: documents.length - skipped, skipped };
  }

  // Default: add_all — insere tudo, exceto o que violaria o indice unico
  // (external_id ja ativo no projeto ou repetido no proprio lote). Sem o filtro,
  // o INSERT em lote falharia inteiro no primeiro conflito.
  const allRows = documents.map((doc) => ({
    project_id: projectId,
    external_id: doc.external_id || null,
    title: doc.title || null,
    text: doc.text,
    text_hash: md5(doc.text),
    metadata: doc.metadata || null,
  }));
  const { rows, skippedExisting, skippedInBatch } =
    await filterActiveExternalIdConflicts(supabase, projectId, allRows);

  if (rows.length > 0) {
    const { error } = await supabase.from("documents").insert(rows);
    if (error) return { error: error.message };
  }

  if (revalidate) {
      revalidatePath(`/projects/${projectId}/config/documents`);
      revalidateTag(`project-${projectId}-documents`, TAG_PROFILE);
    }
  return { count: rows.length, skipped: skippedExisting + skippedInBatch };
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
    const fieldOptionSet = new Map<string, Set<string>>();
    for (const field of fields) {
      if ((field.type === "single" || field.type === "multi") && field.options) {
        fieldOptionSet.set(field.name, new Set(field.options));
      }
    }
    const clean: Record<string, unknown> = {};
    for (const field of fields) {
      const val = rawAnswers[field.name];
      if (val === undefined || val === null) continue;
      if (field.type === "single" && field.options) {
        if (fieldOptionSet.get(field.name)!.has(val as string)) clean[field.name] = val;
      } else if (field.type === "multi" && field.options) {
        const allowed = fieldOptionSet.get(field.name)!;
        const arr = Array.isArray(val) ? val.filter((v: string) => allowed.has(v)) : [];
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

  if (!(await isProjectCoordinator(projectId, user))) {
    return { error: "Apenas coordenador pode excluir documentos" };
  }

  const supabase = await createSupabaseServer();

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
  revalidateTag(`project-${projectId}-progress`, { expire: 60 });
  return { count: documentIds.length };
}

export async function restoreDocuments(
  projectId: string,
  documentIds: string[],
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  if (!(await isProjectCoordinator(projectId, user))) {
    return { error: "Apenas coordenador pode restaurar documentos" };
  }

  const supabase = await createSupabaseServer();

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
  revalidateTag(`project-${projectId}-progress`, { expire: 60 });
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

  if (!(await isProjectCoordinator(projectId, user))) {
    return { error: "Apenas coordenador pode apagar documentos permanentemente" };
  }

  const supabase = await createSupabaseServer();

  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("project_id", projectId)
    .in("id", documentIds);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}/config/documents`);
  revalidateTag(`project-${projectId}-documents`, TAG_PROFILE);
  revalidateTag(`project-${projectId}-progress`, { expire: 60 });
  return { count: documentIds.length };
}
