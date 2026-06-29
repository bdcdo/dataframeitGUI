"use client";

import { useCallback } from "react";
import { getDocumentText } from "@/actions/documents";
import { useCachedResource } from "./useCachedResource";

const NOT_FOUND = "(Documento não encontrado)";

/** Teto do cache de texto. Os consumidores (`CommentsSplitView`, `MyVerdictsView`)
 *  percorrem um conjunto ABERTO de documentos um a um; sem teto, o `text` integral
 *  de todo doc visitado ficaria retido pelo tempo de vida do componente (mesmo
 *  risco de heap que motivou o teto em `useDocumentForCoding`). O teto cobre o
 *  ir-e-voltar imediato entre docs vizinhos; reabrir um doc despejado refaz o
 *  fetch (texto imutável, sem custo de staleness). */
const MAX_CACHED_TEXTS = 10;

/**
 * Lazy-load do texto de um documento, com cache por id e flag `loading`.
 *
 * Wrapper fino de `useCachedResource`: o texto é imutável, então não há
 * `invalidate` no contrato público. Ausência (ou falha do fetch) vira o sentinel
 * `NOT_FOUND` — erro como valor, tratado no próprio `fetcher`, de modo que o
 * genérico nunca entra no estado de `error` e o `loading` sempre resolve.
 *
 * Cobre o padrão Server Action (`getDocumentText`) + cache compartilhado por
 * `MyVerdictsView` e `CommentsSplitView`. Não cobre `DocumentPreview`, que usa
 * outro caminho de dados (Supabase browser client + `allowExcluded`).
 */
export function useDocumentText(
  projectId: string,
  documentId: string | null | undefined,
): { text: string | undefined; loading: boolean } {
  const fetcher = useCallback(
    async (id: string): Promise<string> => {
      try {
        const result = await getDocumentText(projectId, id);
        return result?.text ?? NOT_FOUND;
      } catch (e) {
        console.error("Failed to load document text:", e);
        return NOT_FOUND;
      }
    },
    [projectId],
  );

  const { data, loading } = useCachedResource(documentId, fetcher, {
    maxEntries: MAX_CACHED_TEXTS,
  });
  return { text: data, loading };
}
