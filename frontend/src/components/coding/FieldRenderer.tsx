"use client";

import type { PydanticField } from "@/lib/types";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TEXT_PRESETS = ["Não aplicável", "Não identificável"] as const;

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
  const textValue = (value as string) || "";
  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        {TEXT_PRESETS.map((preset) => {
          const active = textValue === preset;
          return (
            <Button
              key={preset}
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                "h-7 text-xs",
                active && "bg-brand/10 text-brand border-brand/40",
              )}
              onClick={() => onChange(active ? "" : preset)}
            >
              {preset}
            </Button>
          );
        })}
      </div>
      <Textarea
        rows={2}
        value={textValue}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Digite sua resposta..."
        className="resize-y"
      />
    </div>
  );
}
