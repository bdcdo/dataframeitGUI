"use client";

import { useMemo, useState } from "react";
import type { CompareDocument } from "./compare-types";

/**
 * Congela a ordem da fila na ordem do primeiro render. O sort por pendências
 * do Server Component (compare/page.tsx) reexecuta a cada `revalidatePath` —
 * ou seja, a cada veredito: como ordenação de montagem ele prioriza a fila;
 * como re-sort contínuo remexeria a sidebar ("Fila de revisão") sob o usuário,
 * a mesma família de salto do bug #73 que o pin do parecer já corrige.
 *
 * A ordem conhecida só muda quando a COMPOSIÇÃO da lista muda (filtro,
 * exclusão): sobreviventes preservam a posição relativa; docs novos entram ao
 * fim, na ordem do servidor. Ajuste condicional de estado durante o render
 * (mesmo padrão da re-pinagem em `useCompareNavigation`; `set-state-in-effect`
 * proíbe o setState síncrono em effect) — converge porque, com a composição
 * igual, não há setState.
 *
 * `resetKey` cobre o caso em que a composição muda DRASTICAMENTE por uma
 * escolha deliberada do usuário (ex.: alternar a fila de Comparação entre
 * "Meus atribuídos" e "Todos" — mesma instância de componente, sem remount).
 * Sem isso, os poucos docs da fila pessoal ficariam presos no topo da fila
 * "Todos" na ordem antiga, fora da prioridade por pendência que o servidor
 * calculou para o projeto inteiro. Quando `resetKey` muda, a ordem nasce do
 * zero (igual à ordem de `documents`) em vez de mesclar com a anterior.
 * `prevResetKey` é `useState` (não `useRef`): `react-hooks/refs` proíbe ler/
 * escrever `ref.current` fora de effect/handler, então o espelho do valor
 * anterior precisa ser estado, ajustado durante o render como `orderIds`.
 */
export function useStableDocOrder(
  documents: CompareDocument[],
  resetKey: boolean,
): CompareDocument[] {
  const [orderIds, setOrderIds] = useState<string[]>(() =>
    documents.map((d) => d.id),
  );
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  const scopeChanged = prevResetKey !== resetKey;
  if (scopeChanged) {
    setPrevResetKey(resetKey);
  }

  const currentIdSet = new Set(documents.map((d) => d.id));
  const sameComposition =
    !scopeChanged &&
    orderIds.length === currentIdSet.size &&
    orderIds.every((id) => currentIdSet.has(id));
  if (!sameComposition) {
    const knownIdSet = scopeChanged ? new Set<string>() : new Set(orderIds);
    const preserved = scopeChanged ? [] : orderIds.filter((id) => currentIdSet.has(id));
    setOrderIds([
      ...preserved,
      ...documents.map((d) => d.id).filter((id) => !knownIdSet.has(id)),
    ]);
  }

  return useMemo(() => {
    const byId = new Map(documents.map((d) => [d.id, d]));
    return orderIds
      .map((id) => byId.get(id))
      .filter((d): d is CompareDocument => d !== undefined);
  }, [documents, orderIds]);
}
