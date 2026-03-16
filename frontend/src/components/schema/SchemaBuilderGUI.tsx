"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { FieldCard } from "./FieldCard";
import type { PydanticField } from "@/lib/types";

interface SchemaBuilderGUIProps {
  fields: PydanticField[];
  onChange: (fields: PydanticField[]) => void;
}

export function SchemaBuilderGUI({ fields, onChange }: SchemaBuilderGUIProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const addField = () => {
    const newIndex = fields.length;
    onChange([
      ...fields,
      {
        name: `campo_${newIndex + 1}`,
        type: "text",
        options: null,
        description: "",
        target: "all",
      },
    ]);
    setExpandedIndex(newIndex);
  };

  const updateField = (index: number, field: PydanticField) => {
    const next = [...fields];
    next[index] = field;
    onChange(next);
  };

  const removeField = (index: number) => {
    onChange(fields.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index) {
      setExpandedIndex(expandedIndex - 1);
    }
  };

  const moveField = (from: number, to: number) => {
    if (to < 0 || to >= fields.length) return;
    const next = [...fields];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
    if (expandedIndex === from) setExpandedIndex(to);
    else if (expandedIndex === to) setExpandedIndex(from);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
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
              <Plus className="h-4 w-4 mr-1.5" />
              Adicionar primeiro campo
            </Button>
          </div>
        )}

        {fields.map((field, i) => (
          <FieldCard
            key={i}
            field={field}
            index={i}
            total={fields.length}
            isExpanded={expandedIndex === i}
            onToggle={() =>
              setExpandedIndex(expandedIndex === i ? null : i)
            }
            onChange={(f) => updateField(i, f)}
            onRemove={() => removeField(i)}
            onMoveUp={() => moveField(i, i - 1)}
            onMoveDown={() => moveField(i, i + 1)}
          />
        ))}
      </div>

      {fields.length > 0 && (
        <div className="border-t px-4 py-2">
          <Button variant="outline" size="sm" onClick={addField}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Adicionar campo
          </Button>
        </div>
      )}
    </div>
  );
}
