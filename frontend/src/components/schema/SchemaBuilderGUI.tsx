"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { FieldCard } from "./FieldCard";
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

interface SchemaBuilderGUIProps {
  fields: PydanticField[];
  onChange: (fields: PydanticField[]) => void;
}

function nextAvailableFieldName(fields: PydanticField[]): string {
  const names = new Set(fields.map(({ name }) => name));
  let suffix = 1;
  while (names.has(`campo_${suffix}`)) suffix += 1;
  return `campo_${suffix}`;
}

export function SchemaBuilderGUI({ fields, onChange }: SchemaBuilderGUIProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const editorIdPrefix = useId();
  const nextEditorId = useRef(fields.length);
  const [editorIds, setEditorIds] = useState(
    () => fields.map((_, index) => `${editorIdPrefix}:${index}`),
  );
  const renderedEditorIds = fields.map(
    (_, index) => editorIds[index] ?? `${editorIdPrefix}:external:${index}`,
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const addField = () => {
    const newEditorId = `${editorIdPrefix}:${nextEditorId.current}`;
    nextEditorId.current += 1;
    setEditorIds([...renderedEditorIds, newEditorId]);
    onChange([
      ...fields,
      {
        name: nextAvailableFieldName(fields),
        type: "text",
        options: null,
        description: "",
        target: "all",
      },
    ]);
    setExpandedId(newEditorId);
  };

  const updateField = (index: number, field: PydanticField) => {
    const next = [...fields];
    next[index] = field;
    onChange(next);
  };

  const removeField = (index: number) => {
    setEditorIds(renderedEditorIds.filter((_, i) => i !== index));
    onChange(fields.filter((_, i) => i !== index));
    if (expandedId === renderedEditorIds[index]) setExpandedId(null);
  };

  const moveField = (from: number, to: number) => {
    if (from === to || to < 0 || to >= fields.length) return;
    const next = [...fields];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const nextIds = [...renderedEditorIds];
    const [movedId] = nextIds.splice(from, 1);
    nextIds.splice(to, 0, movedId);
    setEditorIds(nextIds);
    onChange(next);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = renderedEditorIds.indexOf(String(active.id));
    const to = renderedEditorIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    moveField(from, to);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {fields.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm text-muted-foreground mb-4">
              Nenhum campo definido. Adicione seu primeiro campo para montar o
              formulário.
            </p>
            <Button
              onClick={addField}
              className="bg-brand hover:bg-brand/90 text-brand-foreground"
            >
              <Plus className="size-4 mr-1.5" />
              Adicionar primeiro campo
            </Button>
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={renderedEditorIds}
            strategy={verticalListSortingStrategy}
          >
            {fields.map((field, i) => (
              <FieldCard
                key={renderedEditorIds[i]}
                id={renderedEditorIds[i]}
                field={field}
                allFields={fields}
                isExpanded={expandedId === renderedEditorIds[i]}
                onToggle={() =>
                  setExpandedId(
                    expandedId === renderedEditorIds[i]
                      ? null
                      : renderedEditorIds[i],
                  )
                }
                onChange={(f) => updateField(i, f)}
                onRemove={() => removeField(i)}
                onAllFieldsChange={onChange}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <div className="border-t px-4 py-2">
        <Button variant="outline" size="sm" onClick={addField}>
          <Plus className="size-3.5 mr-1" />
          Adicionar campo
        </Button>
      </div>
    </div>
  );
}
