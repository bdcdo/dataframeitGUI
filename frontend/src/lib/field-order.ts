import type { PydanticField } from "@/lib/types";

/**
 * Aplica a ordem custom de um pesquisador sobre a ordem canonica de fields.
 *
 * Regras:
 * - order=null/[]: retorna fields como veio (fallback para a ordem do coordenador).
 * - Campos presentes em order e em fields aparecem na ordem de order.
 * - Nomes em order que NAO existem mais em fields sao descartados silenciosamente.
 * - Campos em fields que NAO estao em order vao para o FIM, preservando ordem original.
 *
 * Nunca muda visibilidade — so ordena.
 */
export function applyFieldOrder(
  fields: PydanticField[],
  order: string[] | null,
): PydanticField[] {
  if (!order || order.length === 0) {
    return [...fields];
  }
  const map = new Map<string, PydanticField>();
  for (const f of fields) map.set(f.name, f);

  const ordered: PydanticField[] = [];
  const seen = new Set<string>();
  for (const name of order) {
    const f = map.get(name);
    if (f && !seen.has(name)) {
      ordered.push(f);
      seen.add(name);
    }
  }
  const appended = fields.filter((f) => !seen.has(f.name));
  return [...ordered, ...appended];
}

/**
 * Reconcilia drag-and-drop sobre um subconjunto VISIVEL de fields com a lista COMPLETA.
 *
 * O pesquisador so arrasta o que ve. Mas a ordem persistida precisa cobrir todos os
 * campos (inclusive os ocultos por target="none" ou condition false), senao um campo
 * escondido perde a posicao relativa quando voltar a ficar visivel.
 *
 * Algoritmo:
 * - Aplicar arrayMove sobre visibleNames para obter newVisibleOrder.
 * - Percorrer fullNames; nas posicoes ocupadas por nomes visiveis, substituir em ordem
 *   pelos newVisibleOrder. Nomes invisiveis (nao presentes em visibleNames) ficam no
 *   mesmo lugar.
 */
export function reorderFullList(
  fullNames: string[],
  visibleNames: string[],
  fromVisibleIdx: number,
  toVisibleIdx: number,
): string[] {
  if (fromVisibleIdx === toVisibleIdx) return [...fullNames];
  if (
    fromVisibleIdx < 0 ||
    toVisibleIdx < 0 ||
    fromVisibleIdx >= visibleNames.length ||
    toVisibleIdx >= visibleNames.length
  ) {
    return [...fullNames];
  }

  const newVisible = [...visibleNames];
  const [moved] = newVisible.splice(fromVisibleIdx, 1);
  newVisible.splice(toVisibleIdx, 0, moved);

  const visibleSet = new Set(visibleNames);
  const result: string[] = [];
  let visibleCursor = 0;
  for (const name of fullNames) {
    if (visibleSet.has(name)) {
      result.push(newVisible[visibleCursor]);
      visibleCursor++;
    } else {
      result.push(name);
    }
  }
  return result;
}
