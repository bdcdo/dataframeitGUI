import { useCallback, useState, type RefObject } from "react";
import { toast } from "sonner";
import { isIncompleteOther } from "@/lib/other-option";
import { getScrollBehavior } from "@/lib/scroll";
import { resolveRequired, resolveTarget } from "@/lib/pydantic-field";
import type { PydanticField } from "@/lib/types";

const isAnsweredValue = (field: PydanticField, val: unknown): boolean => {
  if (val === undefined || val === null || val === "") return false;
  if (field.type === "single" && isIncompleteOther(val)) return false;
  if (field.type === "multi" && Array.isArray(val)) {
    if (val.length === 0) return false;
    if (val.some(isIncompleteOther)) return false;
  }
  return true;
};

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

  const requiredFields = visibleFields.filter((f) => resolveRequired(f.required));
  const answeredRequiredCount = requiredFields.filter((f) =>
    isAnsweredValue(f, answers[f.name]),
  ).length;

  const isAnswered = useCallback(
    (field: PydanticField) => isAnsweredValue(field, answers[field.name]),
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

    const unanswered = visibleFields
      .filter(
        (f) =>
          resolveTarget(f.target) !== "llm_only" &&
          resolveRequired(f.required) &&
          !isAnswered(f),
      )
      .map((f) => f.name);

    if (unanswered.length > 0) {
      setHighlightedFields(new Set(unanswered));
      const firstIdx = visibleFields.findIndex((f) => unanswered.includes(f.name));
      questionRefs.current[firstIdx]?.scrollIntoView({ behavior: getScrollBehavior(), block: "center" });
      toast.warning("Preencha todas as perguntas obrigatórias");
      return;
    }

    onSubmit();
  }, [visibleFields, isAnswered, onSubmit, submitting, outOfScopeBlocked, questionRefs]);

  return {
    highlightedFields,
    isAnswered,
    handleAnswerWithClear,
    handleSubmitWithValidation,
    requiredFields,
    answeredRequiredCount,
  };
}
