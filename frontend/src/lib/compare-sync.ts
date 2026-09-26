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

type SyncProjectRow = CompareProjectRow & { current_round_id: string | null };

// Só a rodada corrente (`projects.current_round_id`) é lida e gravada, a mesma
// regra da ressincronização do projeto. Comparação de rodada antiga é
// histórico: reabri-la chamaria um segundo revisor para a célula que a rodada
// corrente já cobre, ou bateria no gatilho contra autoarbitragem quando o
// revisor antigo codificou o documento na rodada corrente. Projeto sem
// `current_round_id` não tem rodada corrente, e não há o que sincronizar.
async function loadSyncProject(
  supabase: SupabaseServerClient,
  projectId: string,
): Promise<SyncProjectRow | null> {
  const { data: project, error } = await supabase
    .from("projects")
    .select(`${COMPARE_PROJECT_SELECT}, current_round_id`)
    .eq("id", projectId)
    .single();
  if (error) throw new Error(error.message, { cause: error });
  return project?.current_round_id ? (project as SyncProjectRow) : null;
}

// Recomputes assignment status for EVERY reviewer with a "comparacao"
// assignment on the document in the current round. Equivalences are shared
// across reviewers (computeDivergentFieldNames does not filter them by
// reviewer), so dissolving or creating a pair changes divergence for everyone —
// syncing only the caller leaves peers stale (#545). Caller must pass a client
// whose RLS reaches the peers' assignments (in practice the admin client, after
// the mutation itself proved authority); with the caller's client, peer updates
// would be silent no-ops under "Researchers update own assignments".
// Per-reviewer failures are logged and skipped so one broken sync doesn't block
// the rest.
//
// A ORDEM da iteração é significativa, e por isso é fixada aqui em vez de
// herdada do SELECT. Na rodada corrente, o documento pode ter várias
// comparações CONCLUÍDAS, de revisores diferentes, e uma dissolução reabre a
// divergência para todas. O índice parcial por (document_id, round_id) admite
// uma só comparação ativa por documento na rodada: quem regride primeiro ocupa
// a vaga, e as seguintes batem no 23505 e são preservadas. Logo a ordem decide
// qual revisor reabre. `sortByReopenPriority` torna essa escolha determinística:
// a comparação ativa primeiro, depois as concluídas da mais recente para a mais
// antiga.
export async function syncCompareAssignmentsForDocument(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
): Promise<void> {
  const project = await loadSyncProject(supabase, projectId);
  if (!project) return;

  const { data: assignments, error } = await supabase
    .from("assignments")
    .select("id, user_id, status, completed_at")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("type", "comparacao")
    .eq("round_id", project.current_round_id);
  if (error) throw new Error(error.message, { cause: error });

  // Uma linha por revisor: a chave única de `assignments` inclui a rodada.
  for (const assignment of sortByReopenPriority(assignments ?? [])) {
    try {
      await syncAssignmentStatus(supabase, project, projectId, documentId, assignment);
    } catch (e) {
      console.error(
        `[compare-sync] falha ao sincronizar o assignment de ${assignment.user_id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

// Recomputes assignment status (pendente / em_andamento / concluido) for the
// reviewer's "comparacao" assignment on this document in the current round,
// taking into account any equivalences registered between responses for
// free-text fields.
export async function syncCompareAssignment(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  userId: string,
) {
  const project = await loadSyncProject(supabase, projectId);
  if (!project) return;

  // Sem o filtro de rodada, o revisor com comparação do documento em duas
  // rodadas devolve duas linhas, e o `maybeSingle` falha com PGRST116.
  const { data: assignment, error } = await supabase
    .from("assignments")
    .select("id, status")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .eq("type", "comparacao")
    .eq("round_id", project.current_round_id)
    .maybeSingle();
  if (error) throw new Error(error.message, { cause: error });
  if (!assignment) return;

  await syncAssignmentStatus(supabase, project, projectId, documentId, {
    ...assignment,
    user_id: userId,
  });
}

async function syncAssignmentStatus(
  supabase: SupabaseServerClient,
  project: SyncProjectRow,
  projectId: string,
  documentId: string,
  assignment: { id: string; user_id: string; status: string | null },
) {
  const userId = assignment.user_id;
  const [
    { data: responses },
    { data: reviews },
    { data: equivalences },
  ] = await Promise.all([
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
    project,
    documentId,
    responses: (responses ?? []) as unknown as ComparisonCandidate[],
    reviews: reviews ?? [],
    equivalences: equivalences ?? [],
  });
  if (next === null) return;

  // Atualiza só quando o status muda, limpando `completed_at` em qualquer
  // regressão (ex.: desmarcar uma equivalência reabre a divergência). Uma
  // comparação concluída pertence ao histórico da rodada. Se já houver outra
  // comparação ativa para o documento na rodada, o índice parcial do banco
  // impede atomicamente que a antiga seja reaberta; nesse caso preservamos a
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
