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
 *
 * `onlyDocumentsWithReviews` troca a leitura paralela por duas fases: os
 * ciclos primeiro, e o `text` só dos documentos que têm ciclo. É para a
 * arbitragem, em que `documentIds` vem dos assignments abertos e o documento
 * sem campo pendente sai da fila. Na auto-revisão todo documento tem ciclo, e
 * a segunda fase só somaria uma ida e volta.
 */
export async function loadReviewQueueRows<
  TFieldReview extends { document_id: string },
>(
  supabase: SupabaseServerClient,
  documentIds: string[],
  loadFieldReviews: (documentIds: string[]) => PagedRead<TFieldReview>,
  { onlyDocumentsWithReviews = false } = {},
): Promise<{
  documents: ReviewQueueDocumentRow[];
  fieldReviews: TFieldReview[];
}> {
  if (documentIds.length === 0) {
    return { documents: [], fieldReviews: [] };
  }

  const fieldReviewsRead = fetchByDocumentChunks(documentIds, loadFieldReviews);
  const loadDocuments = (ids: string[]) =>
    fetchByDocumentChunks<ReviewQueueDocumentRow>(ids, (chunk) =>
      fetchAllAfterId<ReviewQueueDocumentRow>(() =>
        supabase
          .from("documents")
          .select("id, title, external_id, text")
          .in("id", chunk)
          .is("excluded_at", null)
          .is("exclusion_pending_at", null),
      ),
    );

  // `fetchByDocumentChunks` devolve lista vazia na falha: os ciclos que não
  // vieram não pedem documento nenhum, e o erro é lançado abaixo.
  const idsToLoad = onlyDocumentsWithReviews
    ? withReviews(documentIds, (await fieldReviewsRead).data)
    : documentIds;
  const [documents, fieldReviews] = await Promise.all([
    loadDocuments(idsToLoad),
    fieldReviewsRead,
  ]);
  const error = documents.error ?? fieldReviews.error;
  if (error) {
    throw new Error(
      `Não foi possível carregar a fila de revisão: ${error.message}`,
    );
  }
  return { documents: documents.data, fieldReviews: fieldReviews.data };
}

function withReviews(
  documentIds: readonly string[],
  fieldReviews: readonly { document_id: string }[],
): string[] {
  const reviewed = new Set(fieldReviews.map((review) => review.document_id));
  return documentIds.filter((id) => reviewed.has(id));
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
