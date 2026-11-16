// Contador da fila de auto-revisão para o coordenador (#681): quantas
// pendências o projeto tem e com quem estão. Sem isto o único sinal era a aba
// "Auto-revisão" aparecer ou sumir.

import { fetchAllAfterId } from "@/lib/supabase/fetch-all-paged";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import { groupBy } from "@/lib/utils";

interface PendingRow {
  id: string;
  document_id: string;
  self_reviewer_id: string;
}

// Duas unidades porque as duas aparecem no produto: a pendência é por campo
// (uma linha de field_reviews), e a fila do revisor conta documentos.
export interface PendingLoad {
  fields: number;
  documents: number;
}

export interface PendingAutoReviews extends PendingLoad {
  byReviewer: Map<string, PendingLoad>;
}

export type PendingAutoReviewsResult =
  | { data: PendingAutoReviews; error: null }
  | { data: null; error: { message: string } };

// Pendente é o que a fila do revisor mostra (analyze/auto-revisao): revisão
// corrente, sem veredito próprio, de documento que não foi excluído. Lê só o
// dono e o documento de cada linha e agrega aqui: agregar no banco pediria
// função SQL nova, e uma contagem por membro seria uma requisição para cada um.
// A RLS do coordenador enxerga o projeto inteiro.
// A regra mora também na fila: os filtros de field_reviews em
// analyze/auto-revisao/page.tsx e o de exclusão em lib/review-queue.ts. Mudou
// lá, muda aqui.
export async function fetchPendingAutoReviews(
  client: SupabaseServerClient,
  projectId: string,
): Promise<PendingAutoReviewsResult> {
  const { data, error } = await fetchAllAfterId<PendingRow>(() =>
    client
      .from("field_reviews")
      .select(
        "id, document_id, self_reviewer_id, documents!inner(excluded_at, exclusion_pending_at)",
      )
      .eq("project_id", projectId)
      .is("superseded_at", null)
      .is("self_verdict", null)
      .is("documents.excluded_at", null)
      .is("documents.exclusion_pending_at", null),
  );
  if (error) return { data: null, error };

  const distinctDocuments = (rows: readonly PendingRow[]) =>
    new Set(rows.map((row) => row.document_id)).size;
  const byReviewer = new Map<string, PendingLoad>();
  for (const [reviewerId, rows] of groupBy(
    data,
    (row) => row.self_reviewer_id,
  )) {
    byReviewer.set(reviewerId, {
      fields: rows.length,
      documents: distinctDocuments(rows),
    });
  }
  // Campos diferentes de um mesmo documento podem estar com revisores
  // diferentes, então o total de documentos não é a soma dos de cada um.
  return {
    data: {
      fields: data.length,
      documents: distinctDocuments(data),
      byReviewer,
    },
    error: null,
  };
}

// Membros com pendência, do mais carregado para o menos, e os campos pendentes
// de quem não está na lista de membros.
export function breakDownPendingAutoReviews<
  TMember extends { user_id: string },
>(
  pending: PendingAutoReviews,
  members: readonly TMember[],
): {
  reviewers: Array<{ member: TMember; load: PendingLoad }>;
  outsideMemberList: number;
} {
  const reviewers: Array<{ member: TMember; load: PendingLoad }> = [];
  let fieldsWithMembers = 0;
  for (const member of members) {
    const load = pending.byReviewer.get(member.user_id);
    if (!load) continue;
    reviewers.push({ member, load });
    fieldsWithMembers += load.fields;
  }
  reviewers.sort((a, b) => b.load.fields - a.load.fields);
  return { reviewers, outsideMemberList: pending.fields - fieldsWithMembers };
}
