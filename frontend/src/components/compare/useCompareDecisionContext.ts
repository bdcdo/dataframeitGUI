"use client";

import { useMemo } from "react";
import type { ReviewsByDoc } from "@/lib/compare-reviews";
import type { CompareDocument, VerdictOrigin } from "./compare-types";

/**
 * O par (doc, campo) em que a Comparação decide agora. Extraído de
 * `ComparePage` na decomposição do container (#564).
 *
 * - `currentVerdict`: o veredito já registrado para o par, ou `null`.
 * - `ctxKey`: identidade do par mais `readOnly` — a chave dos guards de render
 *   que re-semeiam o comentário e descartam o rascunho (issue #430). `null`
 *   sem doc/campo.
 * - `currentOrigin`: origem do campo EXIBIDO, usada pelos caminhos de escrita
 *   que não passam por rascunho (campo multi e atalhos `a`/`s` de multi). Os
 *   caminhos com rascunho usam a origem carimbada no próprio rascunho.
 */
export function useCompareDecisionContext(
  currentDoc: CompareDocument | undefined,
  currentFieldName: string,
  readOnly: boolean,
  localReviews: ReviewsByDoc,
) {
  const currentOrigin = useMemo<VerdictOrigin | null>(
    () =>
      currentDoc && currentFieldName
        ? { documentId: currentDoc.id, fieldName: currentFieldName }
        : null,
    [currentDoc, currentFieldName],
  );
  if (!currentOrigin) {
    return { currentVerdict: null, ctxKey: null, currentOrigin };
  }
  const { documentId, fieldName } = currentOrigin;
  return {
    currentVerdict: localReviews[documentId]?.[fieldName] ?? null,
    ctxKey: `${documentId}|${fieldName}|${readOnly}`,
    currentOrigin,
  };
}
