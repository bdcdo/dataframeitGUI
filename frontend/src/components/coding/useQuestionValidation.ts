import { useCallback, useMemo, useState, type RefObject } from "react";
import { toast } from "sonner";
import {
  isAnsweredValue,
  missingRequiredHumanFields,
  requiredHumanFields,
} from "@/lib/coding-completeness";
import { getScrollBehavior } from "@/lib/scroll";
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
  missingRequiredCount: number;
} {
  const [highlightedFields, setHighlightedFields] = useState<Set<string>>(new Set());

  // Régua do servidor, avaliada no cliente: o que falta aqui é exatamente o que
  // impede `isCodingComplete` de promover a codificação a concluída.
  const requiredFields = useMemo(
    () => requiredHumanFields(visibleFields, answers),
    [visibleFields, answers],
  );
  const missingRequired = useMemo(
    () => missingRequiredHumanFields(visibleFields, answers),
    [visibleFields, answers],
  );
  const answeredRequiredCount = requiredFields.length - missingRequired.length;

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

    if (missingRequired.length > 0) {
      const unanswered = new Set(missingRequired.map((f) => f.name));
      setHighlightedFields(unanswered);
      const firstIdx = visibleFields.findIndex((f) => unanswered.has(f.name));
      questionRefs.current[firstIdx]?.scrollIntoView({ behavior: getScrollBehavior(), block: "center" });
      toast.warning(
        missingRequired.length === 1
          ? "Falta 1 pergunta obrigatória para enviar"
          : `Faltam ${missingRequired.length} perguntas obrigatórias para enviar`,
      );
      return;
    }

    onSubmit();
  }, [visibleFields, missingRequired, onSubmit, submitting, outOfScopeBlocked, questionRefs]);

  return {
    highlightedFields,
    isAnswered,
    handleAnswerWithClear,
    handleSubmitWithValidation,
    requiredFields,
    answeredRequiredCount,
    missingRequiredCount: missingRequired.length,
  };
}
