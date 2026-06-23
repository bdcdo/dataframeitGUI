"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getDocumentsForBrowse, type BrowseDocument } from "@/actions/documents";

/**
 * Lazy-load da lista de documentos do modo Explorar, com cache por `projectId`
 * e flag `loading` derivada — mesmo padrão de [[useDocumentText]]: o `useEffect`
 * só faz `setCache` assíncrono no `.then`/`.catch`. Isso elimina o
 * `setBrowseLoading(true)` síncrono em effect que disparava o `error`
 * `no-adjust-state-on-prop-change` (e o `no-chain-state-updates`) no
 * `CodingPage`.
 *
 * `markResponded` aplica os updates otimistas pós-envio sobre uma camada de
 * `overrides` (atualizada em handler, nunca em effect): marca o doc como
 * respondido e — só quando `bumpCount` e o doc ainda não constava como
 * respondido — incrementa `responseCount` uma única vez. Espelha exatamente a
 * lógica anterior de `handleBrowseSubmit` (bump) e `handleBrowseBack` (sem
 * bump).
 */
export function useBrowseDocuments(
  projectId: string,
  enabled: boolean,
): {
  documents: BrowseDocument[] | null;
  loading: boolean;
  markResponded: (docId: string, bumpCount: boolean) => void;
} {
  const [cache, setCache] = useState<Record<string, BrowseDocument[]>>({});
  const [overrides, setOverrides] = useState<
    Record<string, { userAlreadyResponded: boolean; responseCount: number }>
  >({});

  useEffect(() => {
    if (!enabled || projectId in cache) return;
    let cancelled = false;
    getDocumentsForBrowse(projectId)
      .then((docs) => {
        if (cancelled) return;
        setCache((prev) => ({ ...prev, [projectId]: docs }));
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load browse documents:", e);
        // Cacheia vazio para não ficar em spinner infinito.
        setCache((prev) => ({ ...prev, [projectId]: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId, cache]);

  const base = enabled ? cache[projectId] : undefined;
  const loading = enabled && !(projectId in cache);

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
    (docId: string, bumpCount: boolean) => {
      const cur = documents?.find((d) => d.id === docId);
      if (!cur) return;
      const responseCount =
        bumpCount && !cur.userAlreadyResponded
          ? cur.responseCount + 1
          : cur.responseCount;
      setOverrides((prev) => ({
        ...prev,
        [docId]: { userAlreadyResponded: true, responseCount },
      }));
    },
    [documents],
  );

  return { documents, loading, markResponded };
}
