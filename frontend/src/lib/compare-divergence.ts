import { normalizeForComparison } from "@/lib/utils";
import { isFieldVisible } from "@/lib/conditional";
import {
  buildResponseGroupKeys,
  filterCurrentEquivalencePairs,
  type EquivalencePair,
} from "@/lib/equivalence";
import { fieldExistedWhenCoded } from "@/lib/answer-staleness";
import {
  multiSelectionSets,
  multiSelectionsAgree,
} from "@/lib/compare-multi-options";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

interface ResponseLike {
  id: string;
  answers: Record<string, unknown> | null | undefined;
  // Snapshot per-campo do schema contra o qual a response foi codificada
  // (1 chave por campo existente na época). Quando presente, não-vazio e a
  // chave do campo não está nele, aquele campo não existia quando a response
  // foi codificada — comparar geraria um falso "(vazio)" divergente.
  // Ausente/null/{} = legacy: não dá para inferir, mantém comportamento antigo
  // de incluir a response.
  answerFieldHashes?: AnswerFieldHashes;
}

// Returns the names of fields whose responses diverge.
// `equivalencesByField` maps fieldName -> list of equivalence pairs for that
// (document, field). When provided, free-text fields use union-find class keys
// instead of raw normalized values, fusing equivalent answers.
export function computeDivergentFieldNames(
  fields: PydanticField[],
  responses: ResponseLike[],
  equivalencesByField?: Map<string, EquivalencePair[]>,
): string[] {
  const divergent: string[] = [];

  for (const field of fields) {
    if (
      field.target === "llm_only" ||
      field.target === "human_only" ||
      field.target === "none"
    )
      continue;

    const applicable = responses.filter((r) => {
      if (!fieldExistedWhenCoded(r.answerFieldHashes, field.name)) return false;
      if (
        field.condition &&
        !isFieldVisible(field, (r.answers as Record<string, unknown>) ?? {})
      )
        return false;
      return true;
    });
    if (applicable.length < 2) continue;

    if (field.type === "multi" && field.options?.length) {
      const responseSets = multiSelectionSets(
        applicable.map((r) => (r.answers as Record<string, unknown>)?.[field.name]),
      );
      if (!multiSelectionsAgree(field.options, responseSets)) {
        divergent.push(field.name);
      }
      continue;
    }

    // Non-multi path: free-text, date e single (com ou sem opções). Union-find
    // sobre pares de equivalência explícitos + arestas de mesma-resposta-
    // normalizada: respostas com a mesma resposta normalizada caem sempre no
    // mesmo grupo, e o revisor pode fundir respostas distintas — ex.: NI ≡ N/A ≡
    // "não informado" num single de opções (issue #247, ponto 5). Sem pares,
    // é equivalente a agrupar por resposta normalizada (comportamento antigo do
    // ramo scalar). multi tem seu próprio caminho (set de opções) acima, pois
    // sua UI de revisão (MultiOptionReview) não tem cards de equivalência.
    const items = applicable.map((r) => ({
      id: r.id,
      answer: (r.answers as Record<string, unknown>)?.[field.name],
    }));
    const pairs = filterCurrentEquivalencePairs(
      items,
      equivalencesByField?.get(field.name) ?? [],
      (item) => item.answer,
    );
    const groupKeys = buildResponseGroupKeys(items, pairs, (r) =>
      normalizeForComparison(r.answer),
    );
    const keys = new Set<string>();
    for (const r of applicable) keys.add(groupKeys.get(r.id) ?? r.id);
    if (keys.size > 1) divergent.push(field.name);
  }

  return divergent;
}
