"use client";

import { useEffect, useState } from "react";
import { getDocumentForCoding } from "@/actions/documents";

export interface CodingDocument {
  document: {
    id: string;
    external_id: string | null;
    title: string | null;
    text: string;
  };
  /** Respostas já existentes do pesquisador, saneadas contra o schema atual. */
  initialAnswers: Record<string, unknown>;
  /** Nota (`justifications._notes`) já existente, ou string vazia. */
  initialNotes: string;
}

/**
 * Lazy-load do payload de codificação de um documento (texto + respostas +
 * notas existentes), com cache por id e flag `loading` derivada.
 *
 * Mesmo padrão de [[useDocumentText]]: o `useEffect` só faz `setCache`
 * assíncrono no `.then`/`.catch`; o `loading` é derivado no render
 * (`!!id && !(id in cache)`), eliminando o `setState` síncrono em effect que
 * antes exigia `eslint-disable react-hooks/set-state-in-effect` no modo
 * Explorar do `CodingPage`. Em erro/documento ausente cacheia `null` para não
 * ficar em spinner infinito.
 *
 * Diferente de `useDocumentText` (só texto), aqui o backend é
 * `getDocumentForCoding`, que também devolve as respostas/justificativas
 * existentes — usadas para semear o estado editável do filho keyed.
 */
export function useDocumentForCoding(
  projectId: string,
  documentId: string | null | undefined,
): { doc: CodingDocument | null | undefined; loading: boolean } {
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

  const doc = documentId ? cache[documentId] : undefined;
  const loading = !!documentId && !(documentId in cache);
  return { doc, loading };
}
