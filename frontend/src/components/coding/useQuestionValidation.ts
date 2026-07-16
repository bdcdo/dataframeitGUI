import { useCallback, useState, type RefObject } from "react";
import { toast } from "sonner";
import { assessFieldAnswer } from "@/lib/field-answer";
import { getScrollBehavior } from "@/lib/scroll";
import { resolveRequired, resolveTarget } from "@/lib/pydantic-field";
import type { PydanticField } from "@/lib/types";

/**
 * Estado de destaque de obrigatórias faltantes + validação de envio. O
 * highlight de um campo só some quando a resposta inteira se torna válida
 * (`handleAnswerWithClear`), e a validação de envio bloqueia por
 * `submitting`/`outOfScopeBlocked` além de checar as obrigatórias visíveis.
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

  const requiredFields = visibleFields.filter(
    (field) =>
      resolveTarget(field.target) !== "llm_only" &&
      resolveTarget(field.target) !== "none" &&
      resolveRequired(field.required),
  );
  const answeredRequiredCount = requiredFields.filter((f) =>
    assessFieldAnswer(f, answers[f.name]).state === "valid",
  ).length;

  const isAnswered = useCallback(
    (field: PydanticField) =>
      assessFieldAnswer(field, answers[field.name]).state === "valid",
    [answers],
  );

  const handleAnswerWithClear = useCallback(
    (fieldName: string, value: unknown) => {
      onAnswer(fieldName, value);
      setHighlightedFields((prev) => {
        if (!prev.has(fieldName)) return prev;
        const field = visibleFields.find((candidate) => candidate.name === fieldName);
        if (!field || assessFieldAnswer(field, value).state !== "valid") return prev;
        const next = new Set(prev);
        next.delete(fieldName);
        return next;
      });
    },
    [onAnswer, visibleFields],
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
