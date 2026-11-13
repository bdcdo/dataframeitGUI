import "server-only";

import type { SupabaseServerClient } from "@/lib/supabase/server";
import type { ComparisonCandidate } from "@/lib/comparison-set";
import { groupValueEquivalencesByField } from "@/lib/equivalence";
import { fetchProjectValueEquivalences } from "@/lib/value-equivalence-query";
import {
  COMPARE_PROJECT_SELECT,
  COMPARE_RESPONSE_SELECT,
  compareAssignmentStatusFor,
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

// Recomputes assignment status (pendente / em_andamento / concluido) for the
// reviewer's "comparacao" assignment on this document in the current round,
// taking into account the project's value equivalences.
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
    equivalences,
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
    // Equivalência de valor vale no projeto inteiro.
    fetchProjectValueEquivalences(supabase, projectId),
  ]);
  if (equivalences.error) {
    throw new Error(`value_equivalences: ${equivalences.error.message}`);
  }

  // A regra (validade do veredito, conjunto de comparação, piso de versão) é
  // a de `compareAssignmentStatusFor`, a mesma da ressincronização do
  // projeto. `null`: menos de 2 respostas que contam, e o status fica.
  const next = compareAssignmentStatusFor({
    project,
    documentId,
    responses: (responses ?? []) as unknown as ComparisonCandidate[],
    reviews: reviews ?? [],
    equivalencesByField: groupValueEquivalencesByField(equivalences.data),
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
