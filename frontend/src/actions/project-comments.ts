"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, isProjectCoordinator } from "@/lib/auth";
import { excludeDocuments } from "@/actions/documents";
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
    kind: "note",
  });

  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return { success: true };
}

// Pesquisador sinaliza documento como fora de escopo. Coordenador resolve em
// /reviews/comments aprovando (soft delete) ou rejeitando.
export async function requestDocumentExclusion(
  projectId: string,
  documentId: string,
  reason: string,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };
  if (!reason?.trim())
    return { error: "Informe o motivo da sugestão de exclusão" };

  const supabase = await createSupabaseServer();

  // Evita duplicata: ja existe pedido pendente do mesmo autor para o mesmo doc?
  const { data: existing } = await supabase
    .from("project_comments")
    .select("id")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("author_id", user.id)
    .eq("kind", "exclusion_request")
    .is("resolved_at", null)
    .is("rejected_at", null)
    .maybeSingle();

  if (existing) {
    return {
      error: "Você já tem uma sugestão pendente para este documento",
    };
  }

  const { error } = await supabase.from("project_comments").insert({
    project_id: projectId,
    document_id: documentId,
    field_name: null,
    author_id: user.id,
    body: reason.trim(),
    parent_id: null,
    kind: "exclusion_request",
  });

  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return { success: true };
}

// Coordenador aprova: faz soft delete no documento (via excludeDocuments para
// usar o mesmo flow do "Excluir" manual) e marca o pedido como resolvido.
export async function approveExclusionRequest(
  commentId: string,
  projectId: string,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  if (!(await isProjectCoordinator(projectId, user))) {
    return { error: "Apenas coordenador pode aprovar sugestões de exclusão" };
  }

  const { data: comment } = await supabase
    .from("project_comments")
    .select("id, document_id, body, kind")
    .eq("id", commentId)
    .eq("project_id", projectId)
    .single();

  if (!comment) return { error: "Sugestão não encontrada" };
  if (comment.kind !== "exclusion_request")
    return { error: "Comentário não é uma sugestão de exclusão" };
  if (!comment.document_id)
    return { error: "Sugestão sem documento associado" };

  const reason = `Aprovada sugestão do pesquisador: ${comment.body}`.slice(
    0,
    1000,
  );

  // 1. soft delete via excludeDocuments — mantem fluxo unificado com o botao
  //    "Excluir" da config de documentos (auditoria e revalidatePath de
  //    config/documents ja saem dele).
  const docResult = await excludeDocuments(
    projectId,
    [comment.document_id],
    reason,
  );
  if ("error" in docResult) return { error: docResult.error };

  // 2. resolver comment
  const { error: commentError } = await supabase
    .from("project_comments")
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: user.id,
    })
    .eq("id", commentId)
    .eq("project_id", projectId);

  if (commentError) return { error: commentError.message };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  // Pesquisador codificando esse doc precisa ver a atualizacao.
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return { success: true };
}

export async function rejectExclusionRequest(
  commentId: string,
  projectId: string,
  rejectionReason: string,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };
  if (!rejectionReason?.trim())
    return { error: "Informe o motivo da rejeição" };

  const supabase = await createSupabaseServer();

  if (!(await isProjectCoordinator(projectId, user))) {
    return { error: "Apenas coordenador pode rejeitar sugestões de exclusão" };
  }

  const { data, error } = await supabase
    .from("project_comments")
    .update({
      rejected_at: new Date().toISOString(),
      rejected_reason: rejectionReason.trim(),
      resolved_by: user.id,
    })
    .eq("id", commentId)
    .eq("project_id", projectId)
    .eq("kind", "exclusion_request")
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0)
    return { error: "Sem permissão para rejeitar esta sugestão" };

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
