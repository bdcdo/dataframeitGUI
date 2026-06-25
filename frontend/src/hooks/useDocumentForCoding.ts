"use client";

import { useCallback, useEffect, useState } from "react";
import { getDocumentForCoding } from "@/actions/documents";

/** Fatia de documento devolvida por `getDocumentForCoding`. Derivada da própria
 *  action para não driftar se o shape do retorno mudar. */
type CodingDocumentSlice = Awaited<
  ReturnType<typeof getDocumentForCoding>
>["document"];

export interface CodingDocument {
  document: CodingDocumentSlice;
  /** Respostas já existentes do pesquisador, saneadas contra o schema atual. */
  initialAnswers: Record<string, unknown>;
  /** Nota (`justifications._notes`) já existente, ou string vazia. */
  initialNotes: string;
}

/**
 * Lazy-load do payload de codificação de um documento (texto + respostas +
 * notas existentes), com cache por id e flag `loading` derivada.
 *
 * Padrão de cache derivado igual ao de `useDocumentText`: o `useEffect` só faz
 * `setCache` assíncrono no `.then`/`.catch` e o `loading` é derivado no render
 * (`!!id && !(id in cache)`), sem `setState` síncrono em effect (era o
 * `eslint-disable react-hooks/set-state-in-effect` do modo Explorar).
 *
 * ATENÇÃO — diferença crítica em relação a `useDocumentText`: aqui o cache
 * guarda respostas/notas MUTÁVEIS (o pesquisador edita e salva via
 * `saveResponse`), não texto imutável. O cache NÃO é invalidado sozinho: quem
 * salva (`handleBrowseSubmit`/`handleBrowseBack`) DEVE chamar `invalidate(docId)`,
 * senão reabrir o doc na mesma sessão re-semearia o estado pré-save (stale). O
 * código antigo evitava isso re-buscando a cada seleção.
 *
 * Contrato de retorno (`doc` é tri-state, sempre lido junto de `loading`):
 *  - `undefined` + `loading=false`: nenhum doc pedido (id null/undefined);
 *  - `undefined` + `loading=true`: pedido, fetch em andamento;
 *  - `null`: o fetch falhou (erro de transporte ou documento ausente) — a UI
 *    deve oferecer "tentar novamente" chamando `invalidate(docId)`;
 *  - objeto `CodingDocument`: carregado.
 */
export function useDocumentForCoding(
  projectId: string,
  documentId: string | null | undefined,
): {
  doc: CodingDocument | null | undefined;
  loading: boolean;
  invalidate: (docId: string) => void;
} {
  const [cache, setCache] = useState<Record<string, CodingDocument | null>>({});

  useEffect(() => {
    if (!documentId || documentId in cache) return;
    let cancelled = false;
    getDocumentForCoding(projectId, documentId)
      .then((result) => {
        if (cancelled) return;
        setCache((prev) => ({
          ...prev,
          [documentId]: {
            document: result.document,
            initialAnswers: result.existingAnswers ?? {},
            initialNotes:
              typeof result.existingJustifications?._notes === "string"
                ? (result.existingJustifications._notes as string)
                : "",
          },
        }));
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load document:", e);
        setCache((prev) => ({ ...prev, [documentId]: null }));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, documentId, cache]);

  // Remove a entrada do cache para que a próxima abertura do doc refaça o
  // fetch. Dois usos: (1) após salvar (submit/back), pois o payload guarda
  // respostas MUTÁVEIS e sem isto reabrir o doc na sessão semearia o estado
  // antigo; (2) como "tentar novamente" quando o fetch falhou (entrada `null`).
  const invalidate = useCallback((docId: string) => {
    setCache((prev) => {
      if (!(docId in prev)) return prev;
      const next = { ...prev };
      delete next[docId];
      return next;
    });
  }, []);

  const doc = documentId ? cache[documentId] : undefined;
  const loading = !!documentId && !(documentId in cache);
  return { doc, loading, invalidate };
}
