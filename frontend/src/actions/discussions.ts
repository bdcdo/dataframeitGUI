"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function createDiscussion(
  projectId: string,
  title: string,
  body?: string,
  documentId?: string
): Promise<{ id?: string; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { error: "Não autenticado" };

    const { data, error } = await supabase
      .from("discussions")
      .insert({
        project_id: projectId,
        title,
        body: body || null,
        document_id: documentId || null,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (error) return { error: error.message };

    revalidatePath(`/projects/${projectId}/discussions`);
    return { id: data.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function addComment(
  discussionId: string,
  body: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const { data: discussion } = await supabase
      .from("discussions")
      .select("project_id, status")
      .eq("id", discussionId)
      .single();

    if (!discussion) return { success: false, error: "Discussão não encontrada" };

    if (discussion.status === "resolved") {
      return { success: false, error: "Discussão já resolvida" };
    }

    const { error } = await supabase.from("discussion_comments").insert({
      discussion_id: discussionId,
      created_by: user.id,
      body,
    });

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${discussion.project_id}/discussions`);
    revalidatePath(`/projects/${discussion.project_id}/discussions/${discussionId}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function resolveDiscussion(
  discussionId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const { data: discussion } = await supabase
      .from("discussions")
      .select("project_id")
      .eq("id", discussionId)
      .single();

    if (!discussion) return { success: false, error: "Discussão não encontrada" };

    const { data: membership } = await supabase
      .from("project_members")
      .select("role")
      .eq("project_id", discussion.project_id)
      .eq("user_id", user.id)
      .single();

    const { data: project } = await supabase
      .from("projects")
      .select("created_by")
      .eq("id", discussion.project_id)
      .single();

    if (membership?.role !== "coordenador" && project?.created_by !== user.id) {
      return { success: false, error: "Sem permissão para esta ação" };
    }

    const { error } = await supabase
      .from("discussions")
      .update({
        status: "resolved",
        resolved_by: user.id,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", discussionId);

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${discussion.project_id}/discussions`);
    revalidatePath(`/projects/${discussion.project_id}/discussions/${discussionId}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}

export async function reopenDiscussion(
  discussionId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createSupabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Não autenticado" };

    const { data: discussion } = await supabase
      .from("discussions")
      .select("project_id")
      .eq("id", discussionId)
      .single();

    if (!discussion) return { success: false, error: "Discussão não encontrada" };

    const { data: membership } = await supabase
      .from("project_members")
      .select("role")
      .eq("project_id", discussion.project_id)
      .eq("user_id", user.id)
      .single();

    const { data: project } = await supabase
      .from("projects")
      .select("created_by")
      .eq("id", discussion.project_id)
      .single();

    if (membership?.role !== "coordenador" && project?.created_by !== user.id) {
      return { success: false, error: "Sem permissão para esta ação" };
    }

    const { error } = await supabase
      .from("discussions")
      .update({
        status: "open",
        resolved_by: null,
        resolved_at: null,
      })
      .eq("id", discussionId);

    if (error) return { success: false, error: error.message };

    revalidatePath(`/projects/${discussion.project_id}/discussions`);
    revalidatePath(`/projects/${discussion.project_id}/discussions/${discussionId}`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro desconhecido" };
  }
}
