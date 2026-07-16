"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import {
  getAuthUser,
  requireCoordinator,
  resolveProjectActor,
} from "@/lib/auth";
import { revalidateProjectDocumentsCache } from "@/actions/documents";
import { revalidatePath } from "next/cache";

function exclusionErrorMessage(message: string): string {
  if (message.includes("requests are disabled")) {
    return "Sinalização de documentos fora do escopo está desligada neste projeto";
  }
  if (message.includes("document not found")) return "Documento não encontrado";
  if (message.includes("already excluded")) {
    return "Documento já foi removido do escopo do projeto";
  }
  if (message.includes("pending exclusion request")) {
    return "Documento já está em revisão de escopo, sinalizado por outro pesquisador";
  }
  if (message.includes("exclusion request not found")) {
    return "Sugestão de exclusão não encontrada";
  }
  if (message.includes("no longer pending")) {
    return "Sugestão de exclusão já foi decidida";
  }
  if (message.includes("orphan exclusion requests cannot be approved")) {
    return "Sugestão sem documento associado não pode ser aprovada";
  }
  return message;
}

async function revalidateExclusionState(projectId: string): Promise<void> {
  revalidatePath(`/projects/${projectId}/reviews/comments`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  await revalidateProjectDocumentsCache(projectId);
}

async function loadCommentActor(projectId: string) {
  const actor = await resolveProjectActor(projectId);
  if (!actor.ok) return { ok: false, error: actor.error } as const;
  return {
    ok: true,
    supabase: await createSupabaseServer(),
    actorId: actor.effectiveUserId,
  } as const;
}

async function decideExclusionRequest(
  commentId: string,
  projectId: string,
  decision: "approve" | "reject",
  reason: string | null,
) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase.rpc("decide_exclusion_request", {
    p_project_id: projectId,
    p_comment_id: commentId,
    p_decision: decision,
    p_reason: reason,
  });
  if (error) return { error: exclusionErrorMessage(error.message) };

  await revalidateExclusionState(projectId);
  return { success: true };
}

async function setProjectCommentResolution(
  commentId: string,
  projectId: string,
  resolved: boolean,
) {
  const context = await loadCommentActor(projectId);
  if (!context.ok) return { error: context.error };
  const { supabase, actorId } = context;
  const { data, error } = await supabase
    .from("project_comments")
    .update({
      resolved_at: resolved ? new Date().toISOString() : null,
      resolved_by: resolved ? actorId : null,
    })
    .eq("id", commentId)
    .eq("project_id", projectId)
    .neq("kind", "exclusion_request")
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0) {
    return {
      error: `Sem permissão para ${resolved ? "resolver" : "reabrir"} este comentário`,
    };
  }

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return { success: true };
}

export async function createProjectComment(
  projectId: string,
  body: string,
  documentId?: string | null,
  fieldName?: string | null,
  parentId?: string | null,
) {
  const context = await loadCommentActor(projectId);
  if (!context.ok) return { error: context.error };
  const { supabase, actorId } = context;

  const { error } = await supabase.from("project_comments").insert({
    project_id: projectId,
    document_id: documentId || null,
    field_name: fieldName || null,
    author_id: actorId,
    body: body.trim(),
    parent_id: parentId || null,
    kind: "note",
  });

  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return { success: true };
}

// Pesquisador sinaliza documento como fora de escopo. O pedido pendente já
// esconde o doc das filas de todos (documents.exclusion_pending_at, mantido
// por trigger no banco); o coordenador resolve em /reviews/comments aprovando
// (soft delete) ou rejeitando (doc volta às filas).
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

  // O banco trava documento/pedidos e valida toggle, estado e duplicidade na
  // mesma transação. Reads de preflight no cliente tinham janela de corrida.
  const { error } = await supabase.rpc("request_document_exclusion", {
    p_project_id: projectId,
    p_document_id: documentId,
    p_reason: reason.trim(),
  });

  if (error) return { error: exclusionErrorMessage(error.message) };

  await revalidateExclusionState(projectId);
  return { success: true };
}

// Autor desfaz o próprio pedido pendente (toggle desligado). DELETE, e não
// auto-resolve: resolved_at setado renderizaria como "aprovado" na fila do
// coordenador. A policy "Authors can delete own pending exclusion requests"
// garante que só o autor apaga, e só enquanto pendente; o trigger de
// recompute devolve o doc às filas.
export async function cancelExclusionRequest(
  projectId: string,
  documentId: string,
) {
  const context = await loadCommentActor(projectId);
  if (!context.ok) return { error: context.error };
  const { supabase, actorId } = context;

  const { data, error } = await supabase
    .from("project_comments")
    .delete()
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("author_id", actorId)
    .eq("kind", "exclusion_request")
    .is("resolved_at", null)
    .is("rejected_at", null)
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0)
    return { error: "Nenhuma sugestão pendente sua para este documento" };

  await revalidateExclusionState(projectId);
  return { success: true };
}

// Coordenador decide em uma única transação: a aprovação exclui o documento e
// o trigger resolve todos os pedidos pendentes; a rejeição atualiza o conjunto.
export async function approveExclusionRequest(
  commentId: string,
  projectId: string,
) {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenador pode aprovar sugestões de exclusão",
  );
  if (!gate.ok) return { error: gate.error };
  return decideExclusionRequest(commentId, projectId, "approve", null);
}

export async function rejectExclusionRequest(
  commentId: string,
  projectId: string,
  rejectionReason: string,
) {
  // Gate de coordenador roda antes da validação de motivo — mesma ordem
  // adotada em excludeDocuments (documents.ts) ao migrar para
  // requireCoordinator, que empacota auth+coordenador como unidade atômica.
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenador pode rejeitar sugestões de exclusão",
  );
  if (!gate.ok) return { error: gate.error };
  if (!rejectionReason?.trim())
    return { error: "Informe o motivo da rejeição" };

  return decideExclusionRequest(
    commentId,
    projectId,
    "reject",
    rejectionReason.trim(),
  );
}

export async function resolveProjectComment(
  commentId: string,
  projectId: string,
) {
  return setProjectCommentResolution(commentId, projectId, true);
}

export async function reopenProjectComment(
  commentId: string,
  projectId: string,
) {
  return setProjectCommentResolution(commentId, projectId, false);
}
