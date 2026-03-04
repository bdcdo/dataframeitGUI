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
  documents: DocumentRow[]
) {
  const supabase = await createSupabaseServer();

  const rows = documents.map((doc) => ({
    project_id: projectId,
    external_id: doc.external_id || null,
    title: doc.title || null,
    text: doc.text,
    metadata: doc.metadata || null,
  }));

  // Batch insert in chunks of 100
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from("documents").insert(chunk);
    if (error) throw new Error(error.message);
  }

  revalidatePath(`/projects/${projectId}/documents`);
  return { count: rows.length };
}

export async function deleteDocument(projectId: string, documentId: string) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId);

  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}/documents`);
}
