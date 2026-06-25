"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getDocumentsForBrowse, type BrowseDocument } from "@/actions/documents";

/**
 * Lazy-load da lista de documentos do modo Explorar, com cache por `projectId`
 * e flag `loading` derivada — mesmo padrão de cache derivado de
 * `useDocumentText`: o `useEffect` só faz `setCache` assíncrono no
 * `.then`/`.catch`, sem `setState` síncrono em effect.
 *
 * Em falha, expõe `error=true` (em vez de cachear `[]`, que mascararia a falha
 * como "projeto sem documentos") e mantém `documents` em `null`; `retry()` limpa
 * o erro e refaz o fetch. A UI deve oferecer "tentar novamente" no estado de erro.
 *
 * `markResponded` aplica os updates otimistas pós-envio sobre uma camada de
 * `overrides` (atualizada em handler, nunca em effect): marca o doc como
 * respondido e — só no intent `"submit"` (envio de resposta nova) e quando o
 * doc ainda não constava como respondido — incrementa `responseCount` uma única
 * vez. O intent `"autosave"` (saída via "Voltar") marca respondido sem mexer no
 * contador. Espelha exatamente a lógica anterior de `handleBrowseSubmit` (bump)
 * e `handleBrowseBack` (sem bump).
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
  const [cache, setCache] = useState<Record<string, BrowseDocument[]>>({});
  const [errors, setErrors] = useState<Record<string, true>>({});
  const [overrides, setOverrides] = useState<
    Record<string, { userAlreadyResponded: boolean; responseCount: number }>
  >({});

  useEffect(() => {
    if (!enabled || projectId in cache || errors[projectId]) return;
    let cancelled = false;
    getDocumentsForBrowse(projectId)
      .then((docs) => {
        if (cancelled) return;
        setCache((prev) => ({ ...prev, [projectId]: docs }));
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load browse documents:", e);
        // Marca erro (em vez de cachear []) para não ficar em spinner infinito
        // E não mascarar a falha como "projeto sem documentos". `retry` limpa.
        setErrors((prev) => ({ ...prev, [projectId]: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId, cache, errors]);

  const base = enabled ? cache[projectId] : undefined;
  const error = enabled && !!errors[projectId];
  const loading = enabled && !(projectId in cache) && !errors[projectId];

  // Limpa o erro (e qualquer cache) do projeto para que o effect refaça o fetch.
  const retry = useCallback(() => {
    setErrors((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    setCache((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, [projectId]);

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
