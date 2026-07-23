"use client";

import { FieldRenderer } from "./FieldRenderer";
import { Check, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { FieldHeaderLabel } from "@/components/shared/FieldHeaderLabel";
import type { PydanticField } from "@/lib/types";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface SortableQuestionProps {
  field: PydanticField;
  index: number;
  isHighlighted: boolean;
  isAnswered: boolean;
  answerValue: unknown;
  onAnswerChange: (val: unknown) => void;
  setRef: (el: HTMLDivElement | null) => void;
  draggable: boolean;
}

export function SortableQuestion({
  field,
  index,
  isHighlighted,
  isAnswered,
  answerValue,
  onAnswerChange,
  setRef,
  draggable,
}: SortableQuestionProps) {
  const sortable = useSortable({ id: field.name, disabled: !draggable });
  const style = draggable
    ? {
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.5 : 1,
      }
    : undefined;

  return (
    <div
      ref={(el) => {
        setRef(el);
        if (draggable) sortable.setNodeRef(el);
      }}
      style={style}
      className={cn(
        "border-l-2 pl-4 py-1.5 rounded-r-md transition-colors",
        isHighlighted
          ? "border-l-destructive bg-destructive/10"
          : isAnswered
            ? "border-brand"
            : "border-muted",
      )}
    >
      <div className="flex items-start gap-1.5">
        {draggable && (
          <button
            type="button"
            className={cn(
              "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground touch-none",
              sortable.isDragging ? "cursor-grabbing" : "cursor-grab",
            )}
            aria-label="Arrastar para reordenar pergunta"
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVertical className="size-3.5" />
          </button>
        )}
        {/* `data-question-body` marca o corpo da resposta (label + controle),
            irmão do drag-handle. A validação de submit foca o primeiro controle
            focável DENTRO deste container, para o cursor cair na pergunta
            pendente e não no botão de reordenar (que precede o corpo no card). */}
        <div className="flex-1 min-w-0" data-question-body>
          <FieldHeaderLabel
            prefix={`${index + 1}.`}
            helpText={field.help_text}
            className="mb-1.5"
          >
            {field.description}
            {field.required === false && (
              <span className="text-xs text-muted-foreground font-normal">(opcional)</span>
            )}
            {isAnswered && <Check className="size-3.5 text-brand shrink-0" />}
          </FieldHeaderLabel>
          <FieldRenderer
            field={field}
            value={answerValue ?? null}
            onChange={onAnswerChange}
          />
        </div>
      </div>
    </div>
  );
}
