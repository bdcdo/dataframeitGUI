"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";

export async function createProjectComment(
  projectId: string,
  body: string,
  documentId?: string | null,
  fieldName?: string | null,
  parentId?: string | null,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const { error } = await supabase.from("project_comments").insert({
    project_id: projectId,
    document_id: documentId || null,
    field_name: fieldName || null,
    author_id: user.id,
    body: body.trim(),
    parent_id: parentId || null,
  });

  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return { success: true };
}

export async function resolveProjectComment(
  commentId: string,
  projectId: string,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const { data, error } = await supabase
    .from("project_comments")
    .update({ resolved_at: new Date().toISOString(), resolved_by: user.id })
    .eq("id", commentId)
    .eq("project_id", projectId)
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: "Sem permissão para resolver este comentário" };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return { success: true };
}

export async function reopenProjectComment(
  commentId: string,
  projectId: string,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const { data, error } = await supabase
    .from("project_comments")
    .update({ resolved_at: null, resolved_by: null })
    .eq("id", commentId)
    .eq("project_id", projectId)
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: "Sem permissão para reabrir este comentário" };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return { success: true };
}
