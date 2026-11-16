"use client";

import { useState } from "react";

/**
 * Comentário editável da Comparação, semeado do veredito do contexto e
 * resetado por guard de render (não por effect, que pintaria um frame com o
 * comentário do campo anterior) quando `ctxKey` muda. O valor anterior da
 * chave fica em `useState`, e não em ref, pelo motivo registrado na docstring
 * de `useResetOnKeyChange` (`react-hooks/refs`).
 *
 * Dispara também na montagem, semeando já o primeiro render — a sentinela
 * `undefined` difere de qualquer chave e de `null`. Por isso não serve o
 * `useResetOnKeyChange`, que nasce com a chave atual e não dispara aí.
 *
 * `ctxKey` identifica (doc, campo, readOnly): trocar de campo re-semeia do novo
 * veredito, entrar ou sair de impersonação descarta o rascunho, e permanecer
 * no campo depois de emitir o veredito preserva o comentário salvo — por isso
 * `useCompareVerdicts` não limpa a caixa no sucesso.
 */
export function useCompareCommentDraft(
  ctxKey: string | null,
  seed: string,
): [string, (value: string) => void] {
  const [comment, setComment] = useState("");
  const [prevCtxKey, setPrevCtxKey] = useState<string | null | undefined>(
    undefined,
  );
  if (ctxKey !== prevCtxKey) {
    setPrevCtxKey(ctxKey);
    setComment(seed);
  }
  return [comment, setComment];
}
