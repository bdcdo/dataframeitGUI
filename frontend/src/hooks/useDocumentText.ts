"use client";

import { useEffect, useState } from "react";
import { getDocumentText } from "@/actions/documents";

const NOT_FOUND = "(Documento não encontrado)";
const LOAD_ERROR = "(Erro ao carregar o documento)";

/**
 * Lazy-load do texto de um documento, com cache por id e flag `loading`.
 *
 * O `loading` é derivado (`!!documentId && !(documentId in cache) && !(documentId
 * in failed)`) em vez de guardado num `useState` — isso elimina o `setState`
 * síncrono no effect que antes exigia `eslint-disable
 * react-hooks/set-state-in-effect`. Os `setCache`/`setFailed` ficam no
 * `.then`/`.catch` (assíncrono), que a regra não sinaliza. O `cache` entra nas
 * deps do effect com um early-return (`documentId in cache`), dispensando o
 * `eslint-disable react-hooks/exhaustive-deps`.
 *
 * Sucesso/inexistência são memoizados em `cache` (resultados estáveis). Já o
 * erro de fetch vai para um mapa `failed` SEPARADO, fora da guarda do effect
 * (`documentId in cache`): assim ele destrava o `loading` e mostra `LOAD_ERROR`
 * (distinto de `NOT_FOUND`), mas NÃO envenena o cache — reabrir/renavegar para o
 * mesmo doc dispara nova tentativa (erro transitório, ex.: blip de rede, se
 * recupera). `setFailed` não está nas deps, então registrar a falha não
 * re-dispara o effect (sem loop de refetch); só uma troca de `documentId`/`cache`
 * o faz.
 *
 * Cobre os três consumidores do texto de documento: `DocumentPreview`,
 * `CommentsSplitView` e `MyVerdictsView`.
 */
export function useDocumentText(
  projectId: string,
  documentId: string | null | undefined,
): { text: string | undefined; loading: boolean } {
  const [cache, setCache] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, true>>({});

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
        setFailed((prev) => ({ ...prev, [documentId]: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, documentId, cache]);

  const text = documentId
    ? (cache[documentId] ?? (documentId in failed ? LOAD_ERROR : undefined))
    : undefined;
  const loading =
    !!documentId && !(documentId in cache) && !(documentId in failed);
  return { text, loading };
}
