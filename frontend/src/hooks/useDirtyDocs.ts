"use client";

import { useCallback, useRef } from "react";

/**
 * Rastreamento de documentos "sujos" (editados sem salvar) por id.
 *
 * Usa `useRef` em vez de `useState`: marcar/limpar não precisa re-renderizar
 * (nada do conjunto é exibido na tela) — isso zera o `rerender-state-only-in-
 * handlers` que o `CodingPage` disparava com um `useState<Set>`. Como o valor
 * é um ref, `isDirty` é uma **função** lida em tempo de evento (handlers e o
 * unload do autosave-on-exit), nunca durante o render.
 */
export function useDirtyDocs(): {
  markDirty: (docId: string) => void;
  markClean: (docId: string) => void;
  isDirty: (docId: string | null | undefined) => boolean;
} {
  // `useRef(null)` + init lazy dentro dos callbacks (tempo de evento): não
  // realoca o Set a cada render e nunca acessa o ref durante o render.
  const ref = useRef<Set<string> | null>(null);

  const markDirty = useCallback((docId: string) => {
    (ref.current ??= new Set()).add(docId);
  }, []);

  const markClean = useCallback((docId: string) => {
    (ref.current ??= new Set()).delete(docId);
  }, []);

  const isDirty = useCallback(
    (docId: string | null | undefined) =>
      !!docId && (ref.current ??= new Set()).has(docId),
    [],
  );

  return { markDirty, markClean, isDirty };
}
