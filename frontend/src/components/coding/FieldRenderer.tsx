"use client";

import type { PydanticField } from "@/lib/types";
import { Textarea } from "@/components/ui/textarea";

interface FieldRendererProps {
  field: PydanticField;
  value: string | string[] | null;
  onChange: (value: string | string[]) => void;
}

export function FieldRenderer({ field, value, onChange }: FieldRendererProps) {
  if (field.type === "single" && field.options) {
    return (
      <div className="flex flex-col gap-2">
        {field.options.map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 hover:bg-muted">
            <input
              type="radio"
              name={field.name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="accent-brand"
            />
            <span className="text-sm">{option}</span>
          </label>
        ))}
      </div>
    );
  }

  if (field.type === "multi" && field.options) {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="flex flex-col gap-2">
        {field.options.map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 hover:bg-muted">
            <input
              type="checkbox"
              value={option}
              checked={selected.includes(option)}
              onChange={(e) => {
                if (e.target.checked) {
                  onChange([...selected, option]);
                } else {
                  onChange(selected.filter((s) => s !== option));
                }
              }}
              className="accent-brand"
            />
            <span className="text-sm">{option}</span>
          </label>
        ))}
      </div>
    );
  }

  // text
  return (
    <Textarea
      rows={2}
      value={(value as string) || ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Digite sua resposta..."
      className="resize-y"
    />
  );
}
