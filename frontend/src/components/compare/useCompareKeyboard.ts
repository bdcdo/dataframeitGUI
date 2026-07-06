"use client";

import { useEffect } from "react";
import type { PydanticField } from "@/lib/types";
import type { FieldResponse } from "./compare-types";

interface UseCompareKeyboardParams {
  isFullscreen: boolean;
  isCurrentDocComplete: boolean;
  isCurrentFieldDivergent: boolean;
  currentField: PydanticField | undefined;
  answerGroups: FieldResponse[][];
  onToggleFullscreen: () => void;
  onExitFullscreen: () => void;
  onNextField: () => void;
  onPrevField: () => void;
  onPrepareVerdict: (verdict: string, chosenResponseId?: string) => void;
  onConfirmPendingVerdict: () => void;
  hasPendingVerdict: boolean;
}

/**
 * Atalhos de teclado da Comparação. Extraído de `ComparePage`: o corpo do
 * effect só chama callbacks recebidos por prop (`onToggleFullscreen`,
 * `onNextField`, `onPrepareVerdict`, …) — nenhum `setState` léxico —, o que zera o
 * `no-cascading-set-state` que o effect inline disparava sem precisar de
 * `useReducer`. `onNextField`/`onPrevField` já fazem o clamp de limite
 * internamente, então as teclas `n`/`p` chamam incondicionalmente.
 */
export function useCompareKeyboard({
  isFullscreen,
  isCurrentDocComplete,
  isCurrentFieldDivergent,
  currentField,
  answerGroups,
  onToggleFullscreen,
  onExitFullscreen,
  onNextField,
  onPrevField,
  onPrepareVerdict,
  onConfirmPendingVerdict,
  hasPendingVerdict,
}: UseCompareKeyboardParams): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      if (e.key === "F" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        onToggleFullscreen();
        return;
      }
      if (e.key === "Escape" && isFullscreen) {
        onExitFullscreen();
        return;
      }

      if (e.key === "n") {
        onNextField();
        return;
      }
      if (e.key === "p") {
        onPrevField();
        return;
      }

      // Doc concluído: o avanço é por ação explícita (botão "Próximo parecer"
      // recebe foco; Enter nele é nativo). Não deixar 1-9/a/s re-disparar
      // veredito sobre um documento já fechado.
      if (isCurrentDocComplete) return;

      if (!isCurrentFieldDivergent) return;

      const isMultiField =
        currentField?.type === "multi" && currentField.options?.length;
      if (isMultiField) return;

      if (e.key === "Enter" && hasPendingVerdict) {
        e.preventDefault();
        onConfirmPendingVerdict();
        return;
      }

      const num = parseInt(e.key);
      if (num >= 1 && num <= answerGroups.length) {
        const group = answerGroups[num - 1];
        const answer = group[0].answer;
        const displayAnswer =
          answer == null
            ? ""
            : Array.isArray(answer)
              ? answer.join(", ")
              : String(answer);
        onPrepareVerdict(displayAnswer, group[0].id);
        return;
      }

      if (e.key === "a") onPrepareVerdict("ambiguo");
      if (e.key === "s") onPrepareVerdict("pular");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    answerGroups,
    currentField,
    isCurrentDocComplete,
    isCurrentFieldDivergent,
    isFullscreen,
    hasPendingVerdict,
    onConfirmPendingVerdict,
    onExitFullscreen,
    onNextField,
    onPrepareVerdict,
    onPrevField,
    onToggleFullscreen,
  ]);
}
