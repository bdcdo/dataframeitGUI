"use client";

import { useState } from "react";
import type { VerdictInfo } from "@/lib/compare-reviews";

interface UseCompareCommentDraftParams {
  // Veredito do contexto atual (doc, campo), do qual o comentário é semeado.
  currentVerdict: VerdictInfo | null;
  // Identidade do par (doc, campo, readOnly). `null` quando não há doc/campo.
  ctxKey: string | null;
}

export interface CompareCommentDraft {
  comment: string;
  setComment: (value: string) => void;
}

/**
 * Comentário editável da Comparação, semeado do veredito do contexto atual e
 * resetado por GUARD DE RENDER (não por effect) quando muda o par (doc, campo,
 * readOnly). Extraído de `ComparePage` como parte da decomposição do container
 * (`no-giant-component`, #564).
 *
 * O guard de render substitui o `useEffect` que disparava `no-derived-state`. O
 * prev-tracker é `useState` (não `useRef`): ler/escrever um ref no corpo do
 * render é proibido por `react-hooks/refs`; o padrão `if (cond) setState()`
 * durante o render é o ajuste-de-estado-no-render documentado do React. O
 * estado inicia em "" (literal, não prop) para não disparar `no-derived-useState`,
 * e a sentinela `undefined` de `prevCtxKey` (≠ qualquer chave e ≠ null) força o
 * guard a disparar no PRIMEIRO render, semeando o comentário do veredito
 * existente já na montagem — o effect original fazia isso depois do paint; aqui
 * é antes. (Diferente de `useResetOnKeyChange`, que inicia `prevKey = key` e
 * portanto NÃO dispara na montagem — aqui a semeadura inicial é necessária.)
 *
 * A chave inclui `readOnly`: trocar de campo re-semeia do veredito do novo
 * campo; entrar/sair de impersonação descarta rascunho da identidade anterior;
 * permanecer no mesmo campo após emitir um veredito preserva o comentário
 * recém-salvo — por isso `useCompareVerdicts` não limpa a caixa no sucesso.
 */
export function useCompareCommentDraft({
  currentVerdict,
  ctxKey,
}: UseCompareCommentDraftParams): CompareCommentDraft {
  const [comment, setComment] = useState("");
  const [prevCtxKey, setPrevCtxKey] = useState<string | null | undefined>(
    undefined,
  );
  if (ctxKey !== prevCtxKey) {
    setPrevCtxKey(ctxKey);
    setComment(currentVerdict?.comment ?? "");
  }
  return { comment, setComment };
}
