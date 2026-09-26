"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { resolveProjectMemberActor } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { syncCompareAssignment } from "@/lib/compare-sync";
import { errorMessage } from "@/lib/utils";
import { copiedVerdictInDomain, OUT_OF_DOMAIN_VOTE_MESSAGE, reviewIsValid } from "@/lib/review-validity";
import { fetchFieldDefinition } from "@/lib/reviews/field-definition";
import type { PydanticField } from "@/lib/types";

export interface ResponseSnapshotEntry {
  id: string;
  respondent_name: string;
  respondent_type: "humano" | "llm";
  answer: unknown;
  justification?: string;
}

export interface SubmitVerdictInput {
  projectId: string;
  documentId: string;
  fieldName: string;
  verdict: string;
  chosenResponseId?: string;
  comment?: string;
  responseSnapshot?: ResponseSnapshotEntry[];
}

export async function submitVerdict({
  projectId,
  documentId,
  fieldName,
  verdict,
  chosenResponseId,
  comment,
  responseSnapshot,
}: SubmitVerdictInput): Promise<{ error?: string }> {
  // Identidade de trabalho no projeto (spec 002): conta vinculada revisa
  // como o membro canônico em reviewer_id e no sync do assignment. Autoria de
  // comentários permanece ligada à conta autenticada.
  const [actor, supabase] = await Promise.all([
    resolveProjectMemberActor(projectId),
    createSupabaseServer(),
  ]);
  if (!actor.ok) return { error: actor.error };
  const { user, memberUserId: effectiveId } = actor;

  try {
    const field = await fetchFieldDefinition(supabase, projectId, fieldName);

    // Voto copiado de uma resposta cujo valor saiu das opções: gravaria com
    // sucesso um veredito que nasce sem validade (`review-validity.ts`). O
    // digitado ("Nenhuma correta") passa: com o hash atual ele vale fora das
    // opções.
    if (chosenResponseId && !copiedVerdictInDomain(verdict, field)) {
      return { error: OUT_OF_DOMAIN_VOTE_MESSAGE };
    }

    const { error } = await supabase.from("reviews").upsert(
      {
        project_id: projectId,
        document_id: documentId,
        field_name: fieldName,
        reviewer_id: effectiveId,
        verdict,
        chosen_response_id: chosenResponseId || null,
        comment: comment || null,
        response_snapshot: responseSnapshot ?? null,
      },
      {
        onConflict: "project_id,document_id,field_name,reviewer_id",
      }
    );

    if (error) throw new Error(error.message);

    await syncAmbiguityComment(supabase, { projectId, documentId, fieldName, field, verdict, comment, authorId: user.id });
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao salvar o veredito" };
  }

  // Efeitos pós-commit best-effort: o veredito já foi gravado. Uma falha no
  // sync do assignment ou na revalidação NÃO deve virar { error } — o revisor
  // veria "falha ao salvar" e tentaria de novo, reescrevendo o mesmo dado (e o
  // estado local em ComparePage já reflete o veredito). Loga e segue.
  try {
    await syncCompareAssignment(supabase, projectId, documentId, effectiveId);
  } catch (e) {
    console.error(
      `[submitVerdict] falha ao sincronizar o assignment pós-veredito: ${errorMessage(e)}`,
    );
  }

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);

  return {};
}

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;

interface ReviewCell {
  projectId: string;
  documentId: string;
  fieldName: string;
}

// Veredito "ambiguo" vira comentário automático na aba Comentários. O
// invariante mantido aqui: existe um project_comments kind='ambiguity' por
// (projeto, documento, campo) se e somente se há ao menos um review válido com
// verdict='ambiguo' para esse campo. O upsert de `submitVerdict` já gravou o
// veredito atual, então as queries enxergam o estado pós-mudança.
async function syncAmbiguityComment(
  supabase: SupabaseServerClient,
  { field, verdict, comment, authorId, ...cell }: ReviewCell & {
    field: PydanticField | undefined;
    verdict: string;
    comment: string | undefined;
    /** A conta autenticada, não o id efetivo (policy de INSERT). */
    authorId: string;
  },
): Promise<void> {
  if (verdict === "ambiguo") await ensureAmbiguityComment(supabase, cell, comment, authorId);
  else await removeOrphanAmbiguityComment(supabase, cell, field);
}

function ambiguityCommentBody(comment: string | undefined): string {
  const note = comment?.trim();
  return note
    ? `Campo marcado como ambíguo na revisão (aba Comparar): ${note}`
    : "Campo marcado como ambíguo na revisão (aba Comparar).";
}

async function ensureAmbiguityComment(
  supabase: SupabaseServerClient,
  { projectId, documentId, fieldName }: ReviewCell,
  comment: string | undefined,
  authorId: string,
): Promise<void> {
  // Idempotente: um único comentário por (projeto, documento, campo) — o
  // índice único parcial idx_pc_ambiguity_unique é o backstop contra corrida.
  const { data: existingAmbiguity } = await supabase
    .from("project_comments")
    .select("id")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("field_name", fieldName)
    .eq("kind", "ambiguity")
    .maybeSingle();
  if (existingAmbiguity) return;

  // author_id é a conta autenticada, não o id efetivo: a policy de INSERT
  // de project_comments exige author_id = clerk_uid() — com effectiveId,
  // uma conta-alias (spec 002) tomaria 42501 aqui.
  const { error: commentError } = await supabase
    .from("project_comments")
    .insert({
      project_id: projectId,
      document_id: documentId,
      field_name: fieldName,
      author_id: authorId,
      body: ambiguityCommentBody(comment),
      kind: "ambiguity",
    });

  // Ignora violação do índice único (revisor concorrente marcou o mesmo
  // campo+doc) — o comentário já existe, que é o estado desejado.
  if (commentError && commentError.code !== "23505") {
    throw new Error(commentError.message);
  }
}

async function removeOrphanAmbiguityComment(
  supabase: SupabaseServerClient,
  { projectId, documentId, fieldName }: ReviewCell,
  field: PydanticField | undefined,
): Promise<void> {
  // Veredito deixou de ser ambíguo. Se nenhum outro revisor ainda marca
  // este campo como ambíguo, remove o comentário automático para não deixar
  // pendência órfã na aba Comentários. Só conta o "ambiguo" que ainda vale
  // (`review-validity.ts`): o dado sobre outra versão da pergunta não é
  // mais o veredito de ninguém. Sem `limit(1)`, porque o primeiro pode ser
  // justamente um inválido; são no máximo um por revisor da célula.
  const { data: ambiguous } = await supabase
    .from("reviews")
    .select("id, field_name, verdict, field_hash, chosen_response_id")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("field_name", fieldName)
    .eq("verdict", "ambiguo");
  const stillAmbiguous = (ambiguous ?? []).some((r) => reviewIsValid(r, field));
  if (stillAmbiguous) return;

  const { error: deleteError } = await supabase
    .from("project_comments")
    .delete()
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("field_name", fieldName)
    .eq("kind", "ambiguity");
  if (deleteError) throw new Error(deleteError.message);
}

// Para docs sem divergência (revisor decide fechar manualmente).
export async function markCompareDocReviewed(
  projectId: string,
  documentId: string,
): Promise<{ error?: string }> {
  // Conta vinculada fecha o doc como o membro canônico (spec 002).
  // Awaits independentes em paralelo.
  const [actor, supabase] = await Promise.all([
    resolveProjectMemberActor(projectId),
    createSupabaseServer(),
  ]);
  if (!actor.ok) return { error: actor.error };
  const effectiveId = actor.memberUserId;

  const { error } = await supabase
    .from("assignments")
    .update({ status: "concluido", completed_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", effectiveId)
    .eq("type", "comparacao");

  if (error) {
    return { error: error.message || "Erro ao marcar o documento como revisado" };
  }

  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  return {};
}
