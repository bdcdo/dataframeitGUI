import type { CompareDocument } from "@/components/compare/compare-types";

/**
 * Fixture de `CompareDocument` compartilhada entre os testes de hooks de
 * compare/ — evita reimplementar a mesma forma em cada arquivo (useStableDocOrder,
 * useCompareNavigation, useCompareVerdicts).
 */
export function doc(id: string, title?: string, text = ""): CompareDocument {
  return {
    id,
    title: title ?? `Doc ${id}`,
    external_id: null,
    text,
  };
}
