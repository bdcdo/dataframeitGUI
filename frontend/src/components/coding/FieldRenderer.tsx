"use client";

import { useRef } from "react";
import type { PydanticField } from "@/lib/types";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Check, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface FieldRendererProps {
  field: PydanticField;
  value: string | string[] | null;
  onChange: (value: string | string[]) => void;
}

const NOT_INFORMED = "Não informada";

function parseDateParts(val: string): [string, string, string] {
  if (!val || val === NOT_INFORMED) return ["", "", ""];
  const parts = val.split("/");
  if (parts.length !== 3) return ["", "", ""];
  return [parts[0], parts[1], parts[2]];
}

function buildDateValue(day: string, month: string, year: string): string {
  if (!day && !month && !year) return "";
  return `${day || "XX"}/${month || "XX"}/${year || "XXXX"}`;
}

function isValidDatePart(
  value: string,
  part: "day" | "month" | "year",
): boolean {
  if (!value) return true;
  const upper = value.toUpperCase();
  if (part === "year") {
    if (upper === "XXXX" || upper === "XX") return true;
    return /^\d{1,4}$/.test(value);
  }
  if (upper === "XX") return true;
  if (!/^\d{1,2}$/.test(value)) return false;
  const n = parseInt(value, 10);
  if (part === "day") return n >= 1 && n <= 31;
  if (part === "month") return n >= 1 && n <= 12;
  return true;
}

function DateFieldRenderer({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [day, month, year] = parseDateParts(value);
  const isNotInformed = value === NOT_INFORMED;
  const monthRef = useRef<HTMLInputElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);

  const handlePart = (
    part: "day" | "month" | "year",
    raw: string,
  ) => {
    let v = raw.toUpperCase().replace(/[^0-9X]/g, "");
    const maxLen = part === "year" ? 4 : 2;
    v = v.slice(0, maxLen);

    const newDay = part === "day" ? v : day;
    const newMonth = part === "month" ? v : month;
    const newYear = part === "year" ? v : year;
    onChange(buildDateValue(newDay, newMonth, newYear));

    // Auto-advance when part is complete
    if (part === "day" && v.length === 2) monthRef.current?.focus();
    if (part === "month" && v.length === 2) yearRef.current?.focus();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "h-7 text-xs",
            isNotInformed && "bg-brand-muted text-brand border-brand",
          )}
          onClick={() => onChange(isNotInformed ? "" : NOT_INFORMED)}
        >
          {isNotInformed && <Check className="mr-1 h-3 w-3" />}
          Não informada
        </Button>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs">
              <p>
                Preencha no formato <strong>DD/MM/AAAA</strong>. Use{" "}
                <strong>XX</strong> para indicar que o dia, mês ou ano não foi
                informado no documento (ex: XX/03/2024).
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {!isNotInformed && (
        <div className="flex items-center gap-1">
          <Input
            className="w-14 text-center text-sm font-mono"
            placeholder="DD"
            value={day}
            onChange={(e) => handlePart("day", e.target.value)}
            maxLength={2}
          />
          <span className="text-muted-foreground">/</span>
          <Input
            ref={monthRef}
            className="w-14 text-center text-sm font-mono"
            placeholder="MM"
            value={month}
            onChange={(e) => handlePart("month", e.target.value)}
            maxLength={2}
          />
          <span className="text-muted-foreground">/</span>
          <Input
            ref={yearRef}
            className="w-20 text-center text-sm font-mono"
            placeholder="AAAA"
            value={year}
            onChange={(e) => handlePart("year", e.target.value)}
            maxLength={4}
          />
        </div>
      )}
    </div>
  );
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

  if (field.type === "date") {
    return (
      <DateFieldRenderer
        value={(value as string) || ""}
        onChange={(v) => onChange(v)}
      />
    );
  }

  // text
  const textValue = (value as string) || "";
  const presets = field.options ?? [];
  const isPresetActive = presets.includes(textValue);

  return (
    <div className="space-y-2">
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => {
            const active = textValue === preset;
            return (
              <Button
                key={preset}
                type="button"
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 text-xs",
                  active && "bg-brand-muted text-brand border-brand",
                )}
                onClick={() => onChange(active ? "" : preset)}
              >
                {active && <Check className="mr-1 h-3 w-3" />}
                {preset}
              </Button>
            );
          })}
        </div>
      )}
      <Textarea
        rows={2}
        value={textValue}
        onChange={(e) => onChange(e.target.value)}
        readOnly={isPresetActive}
        placeholder="Digite sua resposta..."
        className={cn("resize-y", isPresetActive && "opacity-60")}
      />
    </div>
  );
}
