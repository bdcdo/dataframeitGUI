"use client";

import { useEffect, useState } from "react";
import { getDocumentText } from "@/actions/documents";

const NOT_FOUND = "(Documento não encontrado)";

/**
 * Lazy-load do texto de um documento, com cache por chave e flag `loading`.
 *
 * O `loading` é derivado (`!!key && !(key in cache)`) em vez de guardado num
 * `useState` — isso elimina o `setState` síncrono no effect que antes exigia
 * `eslint-disable react-hooks/set-state-in-effect`. O `setCache` fica no `.then`
 * (assíncrono), que a regra não sinaliza. O `cache` entra nas deps do effect com
 * um early-return (`key in cache`), dispensando o `eslint-disable
 * react-hooks/exhaustive-deps`.
 *
 * A chave de cache inclui `allowExcluded` (`${documentId}::${allowExcluded}`)
 * porque um mesmo documento pode ser buscado com e sem o filtro de excluído — e
 * `allowExcluded` pode alternar em runtime (ex.: o coordenador liga "Mostrar
 * excluídos" com o `DocumentPreview` aberto).
 *
 * Cobre os três consumidores do texto de documento: `DocumentPreview`
 * (`allowExcluded` vindo do toggle), `CommentsSplitView` e `MyVerdictsView`
 * (ambos com o default `false`, que oculta soft-deleted).
 */
export function useDocumentText(
  projectId: string | undefined,
  documentId: string | null | undefined,
  options?: { allowExcluded?: boolean },
): { text: string | undefined; loading: boolean } {
  const allowExcluded = options?.allowExcluded ?? false;
  const [cache, setCache] = useState<Record<string, string>>({});

  const key =
    projectId && documentId ? `${documentId}::${allowExcluded}` : null;

  useEffect(() => {
    if (!key || !projectId || !documentId || key in cache) return;
    let cancelled = false;
    getDocumentText(projectId, documentId, allowExcluded).then((result) => {
      if (cancelled) return;
      setCache((prev) => ({
        ...prev,
        [key]: result?.text ?? NOT_FOUND,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [key, projectId, documentId, allowExcluded, cache]);

  const text = key ? cache[key] : undefined;
  const loading = !!key && !(key in cache);
  return { text, loading };
}
