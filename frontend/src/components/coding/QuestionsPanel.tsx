"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FieldRenderer } from "./FieldRenderer";
import { Check, Loader2, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

const OTHER_PREFIX = "Outro: ";
const isIncompleteOther = (v: unknown) =>
  typeof v === "string" && v === OTHER_PREFIX;
const isAnsweredValue = (field: PydanticField, val: unknown): boolean => {
  if (val === undefined || val === null || val === "") return false;
  if (field.type === "single" && isIncompleteOther(val)) return false;
  if (field.type === "multi" && Array.isArray(val)) {
    if (val.length === 0) return false;
    if (val.some(isIncompleteOther)) return false;
  }
  return true;
};

interface QuestionsPanelProps {
  fields: PydanticField[];
  answers: Record<string, any>;
  onAnswer: (fieldName: string, value: any) => void;
  onSubmit: () => void;
  submitting?: boolean;
  notes?: string;
  onNotesChange?: (notes: string) => void;
  readOnly?: boolean;
}

export function QuestionsPanel({ fields, answers, onAnswer, onSubmit, submitting = false, notes = "", onNotesChange, readOnly = false }: QuestionsPanelProps) {
  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [highlightedFields, setHighlightedFields] = useState<Set<string>>(new Set());

  useEffect(() => {
    setHighlightedFields(new Set());
  }, [fields]);

  const requiredFields = fields.filter((f) => f.required !== false);
  const answeredRequiredCount = requiredFields.filter((f) =>
    isAnsweredValue(f, answers[f.name]),
  ).length;

  const isAnswered = useCallback(
    (field: PydanticField) => isAnsweredValue(field, answers[field.name]),
    [answers]
  );

  const handleAnswerWithClear = useCallback(
    (fieldName: string, value: any) => {
      onAnswer(fieldName, value);
      setHighlightedFields((prev) => {
        if (!prev.has(fieldName)) return prev;
        const next = new Set(prev);
        next.delete(fieldName);
        return next;
      });
    },
    [onAnswer]
  );

  const handleSubmitWithValidation = useCallback(() => {
    if (submitting) return;

    const unanswered = fields
      .filter((f) => (f.target || "all") !== "llm_only" && f.required !== false && !isAnswered(f))
      .map((f) => f.name);

    if (unanswered.length > 0) {
      setHighlightedFields(new Set(unanswered));
      const firstIdx = fields.findIndex((f) => unanswered.includes(f.name));
      questionRefs.current[firstIdx]?.scrollIntoView({ behavior: "smooth", block: "center" });
      toast.warning("Preencha todas as perguntas obrigatórias");
      return;
    }

    onSubmit();
  }, [fields, isAnswered, onSubmit, submitting]);

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Header */}
      <div className="border-b px-4 py-2.5 shrink-0">
        <p className="text-xs font-medium text-muted-foreground">
          Perguntas ({answeredRequiredCount}/{requiredFields.length} obrigatórias respondidas)
        </p>
      </div>

      {/* Lista de perguntas scrollável */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {fields.map((field, i) => (
          <div
            key={field.name}
            ref={(el) => { questionRefs.current[i] = el; }}
            className={cn(
              "border-l-2 pl-4 py-2 rounded-r-md transition-colors",
              highlightedFields.has(field.name)
                ? "border-l-destructive bg-destructive/10"
                : isAnswered(field) ? "border-brand" : "border-muted"
            )}
          >
            <p className="text-sm font-medium mb-2 flex items-center gap-1.5">
              <span className="text-muted-foreground">{i + 1}.</span>{" "}
              {field.description}
              {field.required === false && (
                <span className="text-xs text-muted-foreground font-normal">(opcional)</span>
              )}
              {isAnswered(field) && <Check className="h-3.5 w-3.5 text-brand shrink-0" />}
            </p>
            {field.help_text && (
              <p className="text-xs text-muted-foreground mb-2 whitespace-pre-line">{field.help_text}</p>
            )}
            <FieldRenderer
              field={field}
              value={answers[field.name] ?? null}
              onChange={(val) => handleAnswerWithClear(field.name, val)}
            />
          </div>
        ))}

        {/* Notas e sugestões */}
        {onNotesChange && (
          <Collapsible defaultOpen={!!notes}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <MessageSquare className="h-3.5 w-3.5" />
              Notas e sugestões (opcional)
              {notes && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Textarea
                value={notes}
                onChange={(e) => onNotesChange(e.target.value)}
                placeholder="Anotações, dúvidas ou sugestões sobre este documento..."
                className="mt-2 text-sm min-h-[80px] resize-y"
              />
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>

      {/* Footer fixo com botão de enviar */}
      <div className="border-t px-4 py-3 shrink-0">
        <Button
          onClick={handleSubmitWithValidation}
          disabled={submitting || readOnly}
          className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
        >
          {readOnly ? (
            "Somente leitura"
          ) : submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Salvando...
            </>
          ) : (
            "Enviar respostas"
          )}
        </Button>
      </div>
    </div>
  );
}
