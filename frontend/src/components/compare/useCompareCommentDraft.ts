"use client";

import { useState } from "react";

/**
 * Comentário editável da Comparação, semeado do veredito do contexto atual e
 * resetado por GUARD DE RENDER (não por effect) quando muda o contexto. Extraído
 * de `ComparePage` na decomposição do container (#564).
 *
 * O guard de render substituiu um `useEffect` para zerar `no-derived-state`, e
 * o effect pintava um frame com o comentário do campo anterior. O
 * prev-tracker é `useState`, e não `useRef`: ler ou escrever ref no corpo do
 * render cai em `react-hooks/refs` e em `no-ref-current-in-render`. O estado
 * começa em "" (literal, não o parâmetro) para não disparar
 * `no-derived-useState`; a sentinela `undefined` de `prevCtxKey` (diferente de
 * qualquer chave e de `null`) força o guard no PRIMEIRO render, semeando o
 * comentário do veredito existente já na montagem. Por isso não serve o
 * `useResetOnKeyChange`, que nasce com `prevKey = key` e não dispara na
 * montagem.
 *
 * `ctxKey` identifica (doc, campo, readOnly): trocar de campo re-semeia do
 * veredito do novo campo; entrar ou sair de impersonação descarta o rascunho
 * da identidade anterior; permanecer no mesmo campo depois de emitir um
 * veredito preserva o comentário recém-salvo — por isso `useCompareVerdicts`
 * não limpa a caixa no sucesso.
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
