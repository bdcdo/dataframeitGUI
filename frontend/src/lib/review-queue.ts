import "server-only";

import {
  fetchAllAfterId,
  fetchByDocumentChunks,
  type PagedRead,
} from "@/lib/supabase/fetch-all-paged";
import type { SupabaseServerClient } from "@/lib/supabase/server";

export interface ReviewQueueDocumentRow {
  id: string;
  title: string | null;
  external_id: string | null;
  text: string;
}

export interface ReviewQueueDocument<TField> {
  docId: string;
  title: string | null;
  externalId: string | null;
  text: string;
  fields: TField[];
}

/**
 * Carrega a base comum das filas de revisão sem consultar o Supabase quando a
 * fila já está vazia. A query específica de ciclos permanece no chamador, que
 * a restringe aos documentos do lote recebido: a lista inteira num `.in()` só
 * vai na URL do PostgREST e estoura com fila grande. Leitura que falha lança,
 * em vez de abrir a fila sem os documentos do lote (P3).
 */
export async function loadReviewQueueRows<TFieldReview>(
  supabase: SupabaseServerClient,
  documentIds: string[],
  loadFieldReviews: (documentIds: string[]) => PagedRead<TFieldReview>,
): Promise<{
  documents: ReviewQueueDocumentRow[];
  fieldReviews: TFieldReview[];
}> {
  if (documentIds.length === 0) {
    return { documents: [], fieldReviews: [] };
  }

  const [documentsResult, fieldReviewsResult] = await Promise.all([
    fetchByDocumentChunks<ReviewQueueDocumentRow>(documentIds, (ids) =>
      fetchAllAfterId<ReviewQueueDocumentRow>(() =>
        supabase
          .from("documents")
          .select("id, title, external_id, text")
          .in("id", ids)
          .is("excluded_at", null)
          .is("exclusion_pending_at", null),
      ),
    ),
    fetchByDocumentChunks(documentIds, loadFieldReviews),
  ]);
  const error = documentsResult.error ?? fieldReviewsResult.error;
  if (error) {
    throw new Error(
      `Não foi possível carregar a fila de revisão: ${error.message}`,
    );
  }

  return {
    documents: documentsResult.data,
    fieldReviews: fieldReviewsResult.data,
  };
}

export function buildReviewQueueDocumentMap<TField>(
  documents: readonly ReviewQueueDocumentRow[],
): Map<string, ReviewQueueDocument<TField>> {
  return new Map(
    documents.map((document) => [
      document.id,
      {
        docId: document.id,
        title: document.title,
        externalId: document.external_id,
        text: document.text,
        fields: [],
      },
    ]),
  );
}
