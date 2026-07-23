import { useCallback, useState, type RefObject } from "react";
import { toast } from "sonner";
import { getScrollBehavior } from "@/lib/scroll";
import { isFieldAnswered, requiredHumanFields } from "@/lib/coding-completeness";
import type { PydanticField } from "@/lib/types";

/**
 * Estado de destaque de obrigatórias faltantes + validação de envio. O
 * highlight de um campo some assim que ele recebe resposta (`handleAnswerWithClear`),
 * e a validação de envio bloqueia por `submitting`/`outOfScopeBlocked` além de
 * checar as obrigatórias visíveis.
 */
export function useQuestionValidation(
  visibleFields: PydanticField[],
  answers: Record<string, unknown>,
  onAnswer: (fieldName: string, value: unknown) => void,
  onSubmit: () => void,
  submitting: boolean,
  outOfScopeBlocked: boolean,
  questionRefs: RefObject<(HTMLDivElement | null)[]>,
): {
  highlightedFields: Set<string>;
  isAnswered: (field: PydanticField) => boolean;
  handleAnswerWithClear: (fieldName: string, value: unknown) => void;
  handleSubmitWithValidation: () => void;
  requiredFields: PydanticField[];
  answeredRequiredCount: number;
} {
  const [highlightedFields, setHighlightedFields] = useState<Set<string>>(new Set());

  // Contagem e bloqueio derivam da MESMA régua canônica do servidor
  // (`requiredHumanFields`/`isFieldAnswered`, coding-completeness.ts). Sem
  // `answerFieldHashes` = staleness-blind, igual ao gate inline de saveResponse
  // (coding-sync.ts). Antes esta contagem usava `visibleFields.filter(resolveRequired)`,
  // que incluía `llm_only` no denominador (o bloqueio já o excluía), fazendo o
  // header mostrar "N-1/N" para sempre com o submit liberado.
  const requiredFields = requiredHumanFields(visibleFields, answers);
  const answeredRequiredCount = requiredFields.filter((f) =>
    isFieldAnswered(f, answers[f.name]),
  ).length;

  const isAnswered = useCallback(
    (field: PydanticField) => isFieldAnswered(field, answers[field.name]),
    [answers],
  );

  const handleAnswerWithClear = useCallback(
    (fieldName: string, value: unknown) => {
      onAnswer(fieldName, value);
      setHighlightedFields((prev) => {
        if (!prev.has(fieldName)) return prev;
        const next = new Set(prev);
        next.delete(fieldName);
        return next;
      });
    },
    [onAnswer],
  );

  const handleSubmitWithValidation = useCallback(() => {
    if (submitting || outOfScopeBlocked) return;

    const unanswered = requiredFields
      .filter((f) => !isAnswered(f))
      .map((f) => f.name);

    if (unanswered.length > 0) {
      // Um só `Set`: o mesmo conjunto destaca os campos e localiza o primeiro.
      const unansweredSet = new Set(unanswered);
      setHighlightedFields(unansweredSet);
      const firstIdx = visibleFields.findIndex((f) => unansweredSet.has(f.name));
      const firstEl = questionRefs.current[firstIdx];
      firstEl?.scrollIntoView({ behavior: getScrollBehavior(), block: "center" });
      // O ref é o card da pergunta (HTMLDivElement), não o input — focar o
      // primeiro controle focável dentro dele leva o cursor direto à pendência.
      firstEl
        ?.querySelector<HTMLElement>(
          'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
        )
        ?.focus({ preventScroll: true });
      toast.warning("Preencha todas as perguntas obrigatórias");
      return;
    }

    onSubmit();
  }, [requiredFields, visibleFields, isAnswered, onSubmit, submitting, outOfScopeBlocked, questionRefs]);

  return {
    highlightedFields,
    isAnswered,
    handleAnswerWithClear,
    handleSubmitWithValidation,
    requiredFields,
    answeredRequiredCount,
  };
}
