"use client";

import type { HTMLAttributes } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { GripVertical, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PydanticField } from "@/lib/types";
import { resolveRequired, resolveTarget } from "@/lib/pydantic-field";
import { TYPE_LABELS, TYPE_COLORS, TARGET_LABELS } from "@/lib/field-labels";

interface FieldCardHeaderProps {
  field: PydanticField;
  isDragging: boolean;
  /** `{...attributes, ...listeners}` do useSortable — o dnd fica no pai. */
  dragHandleProps: HTMLAttributes<HTMLButtonElement>;
  onRemove: () => void;
}

/**
 * Linha colapsável do FieldCard: drag handle + nome/badges (trigger do
 * Collapsible do pai, via contexto Radix) + botão de remover.
 */
export function FieldCardHeader({
  field,
  isDragging,
  dragHandleProps,
  onRemove,
}: FieldCardHeaderProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      {/* Drag handle */}
      <button
        type="button"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground touch-none",
          isDragging ? "cursor-grabbing" : "cursor-grab"
        )}
        aria-label="Arrastar para reordenar"
        {...dragHandleProps}
      >
        <GripVertical className="size-4" />
      </button>

      {/* Nome + badges */}
      <CollapsibleTrigger asChild>
        <button type="button" className="flex flex-1 items-center gap-2 text-left min-w-0">
          <code className="text-sm font-mono truncate">{field.name}</code>
          <Badge className={cn("text-xs shrink-0", TYPE_COLORS[field.type])}>
            {TYPE_LABELS[field.type]}
          </Badge>
          {resolveTarget(field.target) !== "all" && (
            <Badge className="text-xs shrink-0 bg-amber-500/10 text-amber-700">
              {TARGET_LABELS[resolveTarget(field.target)]}
            </Badge>
          )}
          {!resolveRequired(field.required) && (
            <Badge className="text-xs shrink-0 bg-muted text-muted-foreground">
              Opcional
            </Badge>
          )}
          <span className="text-xs text-muted-foreground truncate ml-auto">
            {field.description}
          </span>
        </button>
      </CollapsibleTrigger>

      {/* Remover */}
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`Remover campo ${field.name}`}
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
