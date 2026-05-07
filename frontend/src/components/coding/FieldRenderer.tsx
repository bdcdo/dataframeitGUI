"use client";

import { useRef, useState } from "react";
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
import { Check, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface FieldRendererProps {
  field: PydanticField;
  value: unknown;
  onChange: (value: unknown) => void;
}

const NOT_INFORMED = "Não informada";
export const OTHER_PREFIX = "Outro: ";
const isOtherValue = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith(OTHER_PREFIX);
const otherText = (v: string) => v.slice(OTHER_PREFIX.length);

function parseDatePartsForUI(val: string): [string, string, string] {
  if (!val || val === NOT_INFORMED) return ["", "", ""];
  const parts = val.split("/");
  if (parts.length !== 3) return ["", "", ""];
  const normalize = (p: string) => (/^X+$/i.test(p) ? "" : p);
  return [normalize(parts[0]), normalize(parts[1]), normalize(parts[2])];
}

function buildDateValue(day: string, month: string, year: string): string {
  if (!day && !month && !year) return "";
  return `${day || "XX"}/${month || "XX"}/${year || "XXXX"}`;
}

function DateFieldRenderer({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options?: string[] | null;
}) {
  const sentinels = (options ?? []).filter((o) => o !== NOT_INFORMED);
  const activeSentinel = sentinels.find((o) => value === o);
  const isNotInformed = value === NOT_INFORMED;
  const isSentinelActive = Boolean(activeSentinel) || isNotInformed;

  const externalForUI = isSentinelActive ? "" : value;
  const [parts, setParts] = useState<[string, string, string]>(() =>
    parseDatePartsForUI(externalForUI),
  );
  const [lastExternal, setLastExternal] = useState(externalForUI);

  // Resync local state during render when `value` changes externally
  // (switching responses, sentinel toggled). During local edits, onChange
  // echoes back the same value, so externalForUI matches buildDateValue(parts)
  // and we skip — otherwise we'd clobber an in-progress empty slot.
  if (externalForUI !== lastExternal) {
    setLastExternal(externalForUI);
    if (externalForUI !== buildDateValue(...parts)) {
      setParts(parseDatePartsForUI(externalForUI));
    }
  }

  const [day, month, year] = parts;
  const dayRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);

  const handlePart = (part: "day" | "month" | "year", raw: string) => {
    const maxLen = part === "year" ? 4 : 2;
    const v = raw.replace(/\D/g, "").slice(0, maxLen);

    const next: [string, string, string] = [
      part === "day" ? v : day,
      part === "month" ? v : month,
      part === "year" ? v : year,
    ];
    setParts(next);
    onChange(buildDateValue(...next));

    if (part === "day" && v.length === 2) monthRef.current?.focus();
    if (part === "month" && v.length === 2) yearRef.current?.focus();
  };

  const handleBackspaceJump = (
    e: React.KeyboardEvent<HTMLInputElement>,
    target: "day" | "month",
  ) => {
    if (e.key === "Backspace" && e.currentTarget.value === "") {
      e.preventDefault();
      if (target === "day") dayRef.current?.focus();
      if (target === "month") monthRef.current?.focus();
    }
  };

  const handleClear = () => {
    setParts(["", "", ""]);
    onChange("");
  };

  const hasContent = Boolean(day || month || year);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
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
        {sentinels.map((opt) => {
          const active = value === opt;
          return (
            <Button
              key={opt}
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                "h-7 text-xs",
                active && "bg-brand-muted text-brand border-brand",
              )}
              onClick={() => onChange(active ? "" : opt)}
            >
              {active && <Check className="mr-1 h-3 w-3" />}
              {opt}
            </Button>
          );
        })}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs">
              <p>
                Formato <strong>DD/MM/AAAA</strong>. Se o documento não informa
                parte da data (ex: só o ano), deixe os campos correspondentes
                em branco.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {!isSentinelActive && (
        <div className="flex items-center gap-1">
          <Input
            ref={dayRef}
            className="w-14 text-center text-sm font-mono"
            placeholder="DD"
            value={day}
            onChange={(e) => handlePart("day", e.target.value)}
            maxLength={2}
            inputMode="numeric"
          />
          <span className="text-muted-foreground">/</span>
          <Input
            ref={monthRef}
            className="w-14 text-center text-sm font-mono"
            placeholder="MM"
            value={month}
            onChange={(e) => handlePart("month", e.target.value)}
            onKeyDown={(e) => handleBackspaceJump(e, "day")}
            maxLength={2}
            inputMode="numeric"
          />
          <span className="text-muted-foreground">/</span>
          <Input
            ref={yearRef}
            className="w-20 text-center text-sm font-mono"
            placeholder="AAAA"
            value={year}
            onChange={(e) => handlePart("year", e.target.value)}
            onKeyDown={(e) => handleBackspaceJump(e, "month")}
            maxLength={4}
            inputMode="numeric"
          />
          {hasContent && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={handleClear}
                    aria-label="Limpar data"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Limpar data
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      )}
    </div>
  );
}

export function FieldRenderer({ field, value, onChange }: FieldRendererProps) {
  if (field.type === "single" && field.options) {
    const otherChecked = isOtherValue(value);
    const otherValue = otherChecked ? otherText(value as string) : "";
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
        {field.allow_other && (
          <div className="space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 hover:bg-muted">
              <input
                type="radio"
                name={field.name}
                checked={otherChecked}
                onChange={() => {
                  if (!otherChecked) onChange(OTHER_PREFIX);
                }}
                className="accent-brand"
              />
              <span className="text-sm">Outro:</span>
            </label>
            {otherChecked && (
              <Input
                value={otherValue}
                onChange={(e) => onChange(OTHER_PREFIX + e.target.value)}
                placeholder="Digite o valor..."
                className="ml-8 h-8 text-sm"
              />
            )}
          </div>
        )}
      </div>
    );
  }

  if (field.type === "multi" && field.options) {
    const selected = Array.isArray(value) ? (value as unknown[]) : [];
    const fixedOptions = field.options;
    const selectedFixed = selected.filter(
      (s): s is string => typeof s === "string" && fixedOptions.includes(s),
    );
    const otherItem = selected.find(isOtherValue) as string | undefined;
    const otherChecked = otherItem !== undefined;
    const otherValue = otherChecked ? otherText(otherItem as string) : "";

    const withOther = (next: string | undefined): string[] =>
      next !== undefined ? [...selectedFixed, next] : [...selectedFixed];

    return (
      <div className="flex flex-col gap-2">
        {field.options.map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 hover:bg-muted">
            <input
              type="checkbox"
              value={option}
              checked={selectedFixed.includes(option)}
              onChange={(e) => {
                const nextFixed = e.target.checked
                  ? [...selectedFixed, option]
                  : selectedFixed.filter((s) => s !== option);
                onChange(
                  otherChecked ? [...nextFixed, otherItem as string] : nextFixed,
                );
              }}
              className="accent-brand"
            />
            <span className="text-sm">{option}</span>
          </label>
        ))}
        {field.allow_other && (
          <div className="space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 hover:bg-muted">
              <input
                type="checkbox"
                checked={otherChecked}
                onChange={(e) => {
                  onChange(withOther(e.target.checked ? OTHER_PREFIX : undefined));
                }}
                className="accent-brand"
              />
              <span className="text-sm">Outro:</span>
            </label>
            {otherChecked && (
              <Input
                value={otherValue}
                onChange={(e) => onChange(withOther(OTHER_PREFIX + e.target.value))}
                placeholder="Digite o valor..."
                className="ml-8 h-8 text-sm"
              />
            )}
          </div>
        )}
      </div>
    );
  }

  if (field.type === "date") {
    return (
      <DateFieldRenderer
        value={(value as string) || ""}
        onChange={(v) => onChange(v)}
        options={field.options}
      />
    );
  }

  // text with subfields
  if (field.type === "text" && field.subfields && field.subfields.length > 0) {
    const objValue =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, string>)
        : {};
    const isNotInformed = value === "Não informada";

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
            onClick={() => onChange(isNotInformed ? {} : "Não informada")}
          >
            {isNotInformed && <Check className="mr-1 h-3 w-3" />}
            Não informada
          </Button>
          {field.subfield_rule === "at_least_one" && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Info className="h-3.5 w-3.5" />
                    Preencha pelo menos um
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  Basta preencher pelo menos um dos campos abaixo.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        {!isNotInformed && (
          <div className="space-y-2">
            {field.subfields.map((sf) => (
              <div key={sf.key} className="flex items-center gap-2">
                <label className="w-32 shrink-0 text-right text-xs text-muted-foreground">
                  {sf.label}
                  {sf.required && field.subfield_rule !== "at_least_one" && (
                    <span className="text-destructive ml-0.5">*</span>
                  )}
                </label>
                <Input
                  className="text-sm"
                  value={objValue[sf.key] || ""}
                  onChange={(e) =>
                    onChange({ ...objValue, [sf.key]: e.target.value })
                  }
                  placeholder={sf.label}
                />
              </div>
            ))}
          </div>
        )}
      </div>
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
