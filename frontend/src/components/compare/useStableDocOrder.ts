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
 */
export function useStableDocOrder(
  documents: CompareDocument[],
): CompareDocument[] {
  const [orderIds, setOrderIds] = useState<string[]>(() =>
    documents.map((d) => d.id),
  );

  const currentIdSet = new Set(documents.map((d) => d.id));
  const sameComposition =
    orderIds.length === currentIdSet.size &&
    orderIds.every((id) => currentIdSet.has(id));
  if (!sameComposition) {
    const knownIdSet = new Set(orderIds);
    setOrderIds([
      ...orderIds.filter((id) => currentIdSet.has(id)),
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
