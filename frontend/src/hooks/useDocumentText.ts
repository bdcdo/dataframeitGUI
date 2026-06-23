"use client";

import { useEffect, useState } from "react";
import { getDocumentText } from "@/actions/documents";

const NOT_FOUND = "(Documento não encontrado)";

/**
 * Lazy-load do texto de um documento, com cache por id e flag `loading`.
 *
 * O `loading` é derivado (`!!documentId && !(documentId in cache)`) em vez de
 * guardado num `useState` — isso elimina o `setState` síncrono no effect que
 * antes exigia `eslint-disable react-hooks/set-state-in-effect`. O `setCache`
 * fica no `.then` (assíncrono), que a regra não sinaliza. O `cache` entra nas
 * deps do effect com um early-return (`documentId in cache`), dispensando o
 * `eslint-disable react-hooks/exhaustive-deps`.
 *
 * Cobre o padrão Server Action (`getDocumentText`) + cache compartilhado por
 * `MyVerdictsView` e `CommentsSplitView`. Não cobre `DocumentPreview`, que usa
 * outro caminho de dados (Supabase browser client + `allowExcluded`).
 */
export function useDocumentText(
  projectId: string,
  documentId: string | null | undefined,
): { text: string | undefined; loading: boolean } {
  const [cache, setCache] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!documentId || documentId in cache) return;
    let cancelled = false;
    getDocumentText(projectId, documentId).then((result) => {
      if (cancelled) return;
      setCache((prev) => ({
        ...prev,
        [documentId]: result?.text ?? NOT_FOUND,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, documentId, cache]);

  const text = documentId ? cache[documentId] : undefined;
  const loading = !!documentId && !(documentId in cache);
  return { text, loading };
}
