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

  // Override guarda a INTENÇÃO (respondido; e se houve bump de contagem), não o
  // valor absoluto. Assim `markResponded` não precisa ler a lista já carregada —
  // o merge abaixo aplica a intenção sobre a base de forma idempotente quando a
  // base chega (corrige a race de deep-link em que a lista ainda não resolveu).
  const [overrides, setOverrides] = useState<
    Record<string, { responded: true; bumped: boolean }>
  >({});

  const retry = useCallback(() => {
    retryResource();
    setOverrides({});
  }, [retryResource]);

  const documents = useMemo(() => {
    if (!base) return null;
    return base.map((d) => {
      const o = overrides[d.id];
      if (!o) return d;
      return {
        ...d,
        userAlreadyResponded: true,
        // +1 só quando o override pediu bump E a base ainda não contava este
        // pesquisador. Recomputado de `base` a cada render → nunca acumula.
        responseCount:
          o.bumped && !d.userAlreadyResponded
            ? d.responseCount + 1
            : d.responseCount,
      };
    });
  }, [base, overrides]);

  // Registra a intenção sem ler `documents`: funciona mesmo com a lista ainda
  // não resolvida. O bump é ADITIVO (uma vez "submit", permanece bumpado) para
  // não se perder se um "autosave" posterior reescrever o mesmo doc.
  const markResponded = useCallback(
    (docId: string, intent: "submit" | "autosave") => {
      setOverrides((prev) => ({
        ...prev,
        [docId]: {
          responded: true,
          bumped: (prev[docId]?.bumped ?? false) || intent === "submit",
        },
      }));
    },
    [],
  );

  return { documents, loading, error, retry, markResponded };
}
