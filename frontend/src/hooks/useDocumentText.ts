"use client";

import { useEffect, useState } from "react";
import { getDocumentText } from "@/actions/documents";

const NOT_FOUND = "(Documento não encontrado)";
const LOAD_ERROR = "(Erro ao carregar o documento)";

/**
 * Lazy-load do texto de um documento, com cache por id e flag `loading`.
 *
 * O `loading` é derivado (`!!documentId && !(documentId in cache)`) em vez de
 * guardado num `useState` — isso elimina o `setState` síncrono no effect que
 * antes exigia `eslint-disable react-hooks/set-state-in-effect`. O `setCache`
 * fica no `.then`/`.catch` (assíncrono), que a regra não sinaliza. O `cache`
 * entra nas deps do effect com um early-return (`documentId in cache`),
 * dispensando o `eslint-disable react-hooks/exhaustive-deps`.
 *
 * Se a Server Action rejeitar, o `.catch` grava `LOAD_ERROR` no cache — isso
 * também destrava o `loading` (sem ele o preview ficaria preso no skeleton para
 * sempre) e mostra mensagem distinta de `NOT_FOUND` (doc inexistente).
 *
 * Cobre os três consumidores do texto de documento: `DocumentPreview`,
 * `CommentsSplitView` e `MyVerdictsView`.
 */
export function useDocumentText(
  projectId: string,
  documentId: string | null | undefined,
): { text: string | undefined; loading: boolean } {
  const [cache, setCache] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!documentId || documentId in cache) return;
    let cancelled = false;
    getDocumentText(projectId, documentId)
      .then((result) => {
        if (cancelled) return;
        setCache((prev) => ({ ...prev, [documentId]: result?.text ?? NOT_FOUND }));
      })
      .catch(() => {
        if (cancelled) return;
        setCache((prev) => ({ ...prev, [documentId]: LOAD_ERROR }));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, documentId, cache]);

  const text = documentId ? cache[documentId] : undefined;
  const loading = !!documentId && !(documentId in cache);
  return { text, loading };
}
