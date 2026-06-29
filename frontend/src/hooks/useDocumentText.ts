"use client";

import { useCallback, useEffect, useState } from "react";
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
 * Além do auto-retry ao renavegar, o hook expõe `error` + `retry()` para o caso
 * de o usuário ficar parado no doc que falhou: `retry()` limpa a marca em
 * `failed` (setState num event handler, não no effect — react-doctor-limpo) e
 * re-busca imperativamente. Limpar `failed` destrava o `loading`, então a
 * re-tentativa manual exibe o skeleton (em vez do erro antigo) enquanto a busca
 * está em voo. O refetch é imperativo de propósito: `failed` não está nas deps
 * do effect, então só limpar a marca não re-dispararia a busca.
 *
 * Cobre os três consumidores do texto de documento: `DocumentPreview`,
 * `CommentsSplitView` e `MyVerdictsView`.
 */
export function useDocumentText(
  projectId: string,
  documentId: string | null | undefined,
): {
  text: string | undefined;
  loading: boolean;
  error: boolean;
  retry: () => void;
} {
  const [cache, setCache] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, true>>({});

  // Busca compartilhada pelo effect (carga inicial / auto-retry ao renavegar) e
  // pelo `retry()` manual. O setState fica no `.then`/`.catch` (assíncrono), que
  // a regra `set-state-in-effect` não sinaliza. Retorna o cleanup de cancelamento.
  const fetchText = useCallback(
    (id: string) => {
      let cancelled = false;
      getDocumentText(projectId, id)
        .then((result) => {
          if (cancelled) return;
          setCache((prev) => ({ ...prev, [id]: result?.text ?? NOT_FOUND }));
        })
        .catch(() => {
          if (cancelled) return;
          setFailed((prev) => ({ ...prev, [id]: true }));
        });
      return () => {
        cancelled = true;
      };
    },
    [projectId],
  );

  useEffect(() => {
    if (!documentId || documentId in cache) return;
    return fetchText(documentId);
  }, [documentId, cache, fetchText]);

  const retry = useCallback(() => {
    if (!documentId) return;
    // Limpa a marca de falha (no handler) para destravar o skeleton e re-busca.
    setFailed((prev) => {
      if (!(documentId in prev)) return prev;
      const rest = { ...prev };
      delete rest[documentId];
      return rest;
    });
    fetchText(documentId);
  }, [documentId, fetchText]);

  const text = documentId
    ? (cache[documentId] ?? (documentId in failed ? LOAD_ERROR : undefined))
    : undefined;
  const loading =
    !!documentId && !(documentId in cache) && !(documentId in failed);
  const error =
    !!documentId && documentId in failed && !(documentId in cache);
  return { text, loading, error, retry };
}
