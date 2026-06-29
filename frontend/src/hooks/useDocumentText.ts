"use client";

import { useCallback } from "react";
import { getDocumentText } from "@/actions/documents";
import { useCachedResource } from "./useCachedResource";

const NOT_FOUND = "(Documento não encontrado)";

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

  const { data, loading } = useCachedResource(documentId, fetcher);
  return { text: data, loading };
}
