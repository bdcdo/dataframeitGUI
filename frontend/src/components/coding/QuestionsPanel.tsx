"use client";

import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { FieldRenderer } from "./FieldRenderer";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PydanticField } from "@/lib/types";

interface QuestionsPanelProps {
  fields: PydanticField[];
  answers: Record<string, any>;
  onAnswer: (fieldName: string, value: any) => void;
  onSubmit: () => void;
  submitting?: boolean;
}

export function QuestionsPanel({ fields, answers, onAnswer, onSubmit, submitting = false }: QuestionsPanelProps) {
  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);

  const requiredFields = fields.filter((f) => f.required !== false);
  const answeredRequiredCount = requiredFields.filter(
    (f) => answers[f.name] !== undefined && answers[f.name] !== null && answers[f.name] !== ""
  ).length;

  const isAnswered = useCallback(
    (field: PydanticField) => {
      const val = answers[field.name];
      return val !== undefined && val !== null && val !== "";
    },
    [answers]
  );

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
              "border-l-2 pl-4 py-2 transition-colors",
              isAnswered(field) ? "border-brand" : "border-muted"
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
            <FieldRenderer
              field={field}
              value={answers[field.name] ?? null}
              onChange={(val) => onAnswer(field.name, val)}
            />
          </div>
        ))}
      </div>

      {/* Footer fixo com botão de enviar */}
      <div className="border-t px-4 py-3 shrink-0">
        <Button
          onClick={onSubmit}
          disabled={submitting}
          className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
        >
          {submitting ? (
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
