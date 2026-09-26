import "server-only";

import type { SupabaseServerClient } from "@/lib/supabase/server";
import type { ComparisonCandidate } from "@/lib/comparison-set";
import {
  COMPARE_EQUIVALENCE_SELECT,
  COMPARE_PROJECT_SELECT,
  COMPARE_RESPONSE_SELECT,
  compareAssignmentStatusFor,
  sortByReopenPriority,
  updateCompareAssignmentStatus,
  type CompareProjectRow,
} from "@/lib/compare-assignment-sync";

// Recomputes assignment status for EVERY reviewer with a "comparacao"
// assignment on the document. Equivalences are shared across reviewers
// (computeDivergentFieldNames does not filter them by reviewer), so dissolving
// or creating a pair changes divergence for everyone — syncing only the caller
// leaves peers stale (#545). Caller must pass a client whose RLS reaches the
// peers' assignments (in practice the admin client, after the mutation itself
// proved authority); with the caller's client, peer updates would be silent
// no-ops under "Researchers update own assignments". Per-reviewer failures are
// logged and skipped so one broken sync doesn't block the rest.
//
// A ORDEM da iteração é significativa, e por isso é fixada aqui em vez de
// herdada do SELECT. O documento pode ter comparações CONCLUÍDAS de rodadas
// anteriores (o índice parcial assignments_one_active_comparacao_per_doc as
// mantém fora do predicado de propósito), e uma dissolução reabre divergência
// para todas elas. Como só UMA pode voltar a ser ativa, quem regride primeiro
// ocupa a vaga e as seguintes batem no 23505 e são preservadas — logo a ordem
// decide qual rodada reabre. `sortByReopenPriority` torna essa escolha
// determinística e semanticamente correta: a comparação ativa primeiro (é a
// rodada em curso), depois as concluídas da mais recente para a mais antiga.
// Sem isso, a ordem de retorno do Postgres poderia ressuscitar a rodada
// arquivada e deixar a corrente indevidamente fechada.
export async function syncCompareAssignmentsForDocument(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
): Promise<void> {
  const { data: assignments, error } = await supabase
    .from("assignments")
    .select("user_id, status, completed_at")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("type", "comparacao");
  if (error) throw new Error(error.message, { cause: error });

  const userIds = [
    ...new Set(sortByReopenPriority(assignments ?? []).map((a) => a.user_id)),
  ];
  for (const userId of userIds) {
    try {
      await syncCompareAssignment(supabase, projectId, documentId, userId);
    } catch (e) {
      console.error(
        `[compare-sync] falha ao sincronizar o assignment de ${userId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

// Recomputes assignment status (pendente / em_andamento / concluido) for the
// reviewer's "comparacao" assignment on this document, taking into account
// any equivalences registered between responses for free-text fields.
export async function syncCompareAssignment(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  userId: string,
) {
  const { data: assignment } = await supabase
    .from("assignments")
    .select("id, status")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .eq("type", "comparacao")
    .maybeSingle();

  if (!assignment) return;

  const [
    { data: project },
    { data: responses },
    { data: reviews },
    { data: equivalences },
  ] = await Promise.all([
    supabase.from("projects").select(COMPARE_PROJECT_SELECT).eq("id", projectId).single(),
    supabase
      .from("responses")
      .select(COMPARE_RESPONSE_SELECT)
      .eq("project_id", projectId)
      .eq("document_id", documentId),
    supabase
      .from("reviews")
      .select("field_name, verdict, field_hash, chosen_response_id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("reviewer_id", userId),
    supabase
      .from("response_equivalences")
      .select(COMPARE_EQUIVALENCE_SELECT)
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .is("superseded_at", null),
  ]);

  // A regra (validade do veredito, conjunto de comparação, piso de versão) é
  // a de `compareAssignmentStatusFor`, a mesma da ressincronização do
  // projeto. `null`: menos de 2 respostas que contam, e o status fica.
  const next = compareAssignmentStatusFor({
    project: (project ?? { pydantic_fields: [] }) as CompareProjectRow,
    documentId,
    responses: (responses ?? []) as unknown as ComparisonCandidate[],
    reviews: reviews ?? [],
    equivalences: equivalences ?? [],
  });
  if (next === null) return;

  // Atualiza só quando o status muda, limpando `completed_at` em qualquer
  // regressão (ex.: desmarcar uma equivalência reabre a divergência). Uma
  // comparação concluída pertence ao histórico da rodada. Se já houver outra
  // comparação ativa para o documento, o índice parcial do banco impede
  // atomicamente que a antiga seja reaberta; nesse caso preservamos a
  // concluída de propósito e `updateCompareAssignmentStatus` registra o
  // bloqueio (#497).
  if (assignment.status !== next) {
    await updateCompareAssignmentStatus({
      supabase,
      projectId,
      documentId,
      userId,
      assignment,
      next,
    });
  }
}
