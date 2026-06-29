"use client";

import { useCallback, useMemo, useState } from "react";
import { getDocumentsForBrowse, type BrowseDocument } from "@/actions/documents";
import { useCachedResource } from "./useCachedResource";

/**
 * Lazy-load da lista de documentos do modo Explorar, com cache por `projectId`
 * e flag `loading` derivada.
 *
 * Wrapper de `useCachedResource` (cache/loading/erro/retry vêm do genérico, sem
 * `maxEntries` — só há uma entrada, a do projeto). Em falha o `fetcher` rejeita,
 * então o genérico expõe `error=true` SEM cachear (não mascara como "projeto sem
 * documentos"); `retry()` limpa o erro/cache e refaz o fetch.
 *
 * `markResponded` aplica os updates otimistas pós-envio sobre uma camada local
 * de `overrides` (atualizada em handler, nunca em effect): marca o doc como
 * respondido e — só no intent `"submit"` (envio de resposta nova) e quando o
 * doc ainda não constava como respondido — incrementa `responseCount` uma única
 * vez. O intent `"autosave"` (saída via "Voltar") marca respondido sem mexer no
 * contador. Espelha exatamente a lógica anterior de `handleBrowseSubmit` (bump)
 * e `handleBrowseBack` (sem bump). O `retry()` também zera os `overrides`: um
 * refetch traz dados frescos do servidor, e overrides antigos os clobbeariam.
 */
export function useBrowseDocuments(
  projectId: string,
  enabled: boolean,
): {
  documents: BrowseDocument[] | null;
  loading: boolean;
  error: boolean;
  retry: () => void;
  markResponded: (docId: string, intent: "submit" | "autosave") => void;
} {
  const fetcher = useCallback(
    (id: string): Promise<BrowseDocument[]> => getDocumentsForBrowse(id),
    [],
  );

  const {
    data: base,
    loading,
    error,
    retry: retryResource,
  } = useCachedResource(projectId, fetcher, { enabled });

  const [overrides, setOverrides] = useState<
    Record<string, { userAlreadyResponded: boolean; responseCount: number }>
  >({});

  const retry = useCallback(() => {
    retryResource();
    setOverrides({});
  }, [retryResource]);

  const documents = useMemo(() => {
    if (!base) return null;
    return base.map((d) => {
      const o = overrides[d.id];
      return o ? { ...d, ...o } : d;
    });
  }, [base, overrides]);

  // Lê o estado mesclado atual (base + overrides anteriores) pela closure: o
  // callback recria quando `documents` muda, então a contagem nunca é dobrada.
  const markResponded = useCallback(
    (docId: string, intent: "submit" | "autosave") => {
      const cur = documents?.find((d) => d.id === docId);
      if (!cur) return;
      const responseCount =
        intent === "submit" && !cur.userAlreadyResponded
          ? cur.responseCount + 1
          : cur.responseCount;
      setOverrides((prev) => ({
        ...prev,
        [docId]: { userAlreadyResponded: true, responseCount },
      }));
    },
    [documents],
  );

  return { documents, loading, error, retry, markResponded };
}
