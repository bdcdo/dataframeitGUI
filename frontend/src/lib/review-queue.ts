import "server-only";

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

interface RowsResult<TRow> {
  data: TRow[] | null;
}

/**
 * Carrega a base comum das filas de revisão sem consultar o Supabase quando a
 * fila já está vazia. A query específica de ciclos permanece no chamador.
 */
export async function loadReviewQueueRows<TFieldReview>(
  supabase: SupabaseServerClient,
  documentIds: string[],
  loadFieldReviews: () => PromiseLike<RowsResult<TFieldReview>>,
): Promise<{
  documents: ReviewQueueDocumentRow[];
  fieldReviews: TFieldReview[];
}> {
  if (documentIds.length === 0) {
    return { documents: [], fieldReviews: [] };
  }

  const [documentsResult, fieldReviewsResult] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title, external_id, text")
      .in("id", documentIds)
      .is("excluded_at", null)
      .is("exclusion_pending_at", null),
    loadFieldReviews(),
  ]);

  return {
    documents: (documentsResult.data ?? []) as ReviewQueueDocumentRow[],
    fieldReviews: fieldReviewsResult.data ?? [],
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
