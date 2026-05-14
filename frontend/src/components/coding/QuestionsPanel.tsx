"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FieldRenderer } from "./FieldRenderer";
import { Check, GripVertical, Loader2, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { isFieldVisible } from "@/lib/conditional";
import { reorderFullList } from "@/lib/field-order";
import type { PydanticField } from "@/lib/types";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

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
  onReorder?: (newOrder: string[]) => void;
}

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

function SortableQuestion({
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
        "border-l-2 pl-4 py-2 rounded-r-md transition-colors",
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
              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground touch-none",
              sortable.isDragging ? "cursor-grabbing" : "cursor-grab",
            )}
            aria-label="Arrastar para reordenar pergunta"
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium mb-2 flex items-center gap-1.5">
            <span className="text-muted-foreground">{index + 1}.</span> {field.description}
            {field.required === false && (
              <span className="text-xs text-muted-foreground font-normal">(opcional)</span>
            )}
            {isAnswered && <Check className="h-3.5 w-3.5 text-brand shrink-0" />}
          </p>
          {field.help_text && (
            <p className="text-xs text-muted-foreground mb-2 whitespace-pre-line">
              {field.help_text}
            </p>
          )}
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

export function QuestionsPanel({ fields, answers, onAnswer, onSubmit, submitting = false, notes = "", onNotesChange, readOnly = false, onReorder }: QuestionsPanelProps) {
  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [highlightedFields, setHighlightedFields] = useState<Set<string>>(new Set());

  useEffect(() => {
    setHighlightedFields(new Set());
  }, [fields]);

  const visibleFields = useMemo(
    () =>
      fields.filter(
        (f) =>
          f.target !== "none" &&
          f.target !== "regex" &&
          isFieldVisible(f, answers),
      ),
    [fields, answers],
  );
  const visibleNames = useMemo(
    () => new Set(visibleFields.map((f) => f.name)),
    [visibleFields],
  );

  useEffect(() => {
    if (readOnly) return;
    for (const f of fields) {
      if (!f.condition) continue;
      if (visibleNames.has(f.name)) continue;
      const v = answers[f.name];
      if (v !== undefined && v !== null && v !== "") {
        onAnswer(f.name, null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNames]);

  const requiredFields = visibleFields.filter((f) => f.required !== false);
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

    const unanswered = visibleFields
      .filter((f) => (f.target || "all") !== "llm_only" && f.required !== false && !isAnswered(f))
      .map((f) => f.name);

    if (unanswered.length > 0) {
      setHighlightedFields(new Set(unanswered));
      const firstIdx = visibleFields.findIndex((f) => unanswered.includes(f.name));
      questionRefs.current[firstIdx]?.scrollIntoView({ behavior: "smooth", block: "center" });
      toast.warning("Preencha todas as perguntas obrigatórias");
      return;
    }

    onSubmit();
  }, [visibleFields, isAnswered, onSubmit, submitting]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const dragEnabled = !!onReorder && !readOnly;

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!onReorder) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const visibleNamesArr = visibleFields.map((f) => f.name);
      const from = visibleNamesArr.indexOf(String(active.id));
      const to = visibleNamesArr.indexOf(String(over.id));
      if (from < 0 || to < 0) return;
      const newOrder = reorderFullList(
        fields.map((f) => f.name),
        visibleNamesArr,
        from,
        to,
      );
      onReorder(newOrder);
    },
    [fields, visibleFields, onReorder],
  );

  const questionItems = (
    <>
      {visibleFields.map((field, i) => (
        <SortableQuestion
          key={field.name}
          field={field}
          index={i}
          isHighlighted={highlightedFields.has(field.name)}
          isAnswered={isAnswered(field)}
          answerValue={answers[field.name]}
          onAnswerChange={(val) => handleAnswerWithClear(field.name, val)}
          setRef={(el) => {
            questionRefs.current[i] = el;
          }}
          draggable={dragEnabled}
        />
      ))}
    </>
  );

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="border-b px-4 py-2.5 shrink-0">
        <p className="text-xs font-medium text-muted-foreground">
          Perguntas ({answeredRequiredCount}/{requiredFields.length} obrigatórias respondidas)
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {dragEnabled ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={visibleFields.map((f) => f.name)}
              strategy={verticalListSortingStrategy}
            >
              {questionItems}
            </SortableContext>
          </DndContext>
        ) : (
          questionItems
        )}

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
