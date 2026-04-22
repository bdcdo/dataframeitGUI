"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { FieldCondition, PydanticField } from "@/lib/types";

type Op = "equals" | "not_equals" | "in" | "not_in" | "exists";

const OP_LABELS: Record<Op, string> = {
  equals: "é igual a",
  not_equals: "é diferente de",
  in: "é um de",
  not_in: "não é um de",
  exists: "foi respondido",
};

function currentOp(condition: FieldCondition | undefined): Op | null {
  if (!condition) return null;
  if ("equals" in condition) return "equals";
  if ("not_equals" in condition) return "not_equals";
  if ("in" in condition) return "in";
  if ("not_in" in condition) return "not_in";
  if ("exists" in condition) return "exists";
  return null;
}

function buildCondition(
  op: Op,
  triggerName: string,
  prev: FieldCondition | undefined,
): FieldCondition {
  if (op === "exists") {
    const existsValue =
      prev && "exists" in prev ? prev.exists : true;
    return { field: triggerName, exists: existsValue };
  }
  if (op === "in" || op === "not_in") {
    const carry =
      prev && "in" in prev
        ? prev.in
        : prev && "not_in" in prev
          ? prev.not_in
          : [];
    return op === "in"
      ? { field: triggerName, in: carry }
      : { field: triggerName, not_in: carry };
  }
  const scalar =
    prev && "equals" in prev
      ? prev.equals
      : prev && "not_equals" in prev
        ? prev.not_equals
        : "";
  return op === "equals"
    ? { field: triggerName, equals: scalar }
    : { field: triggerName, not_equals: scalar };
}

interface ConditionEditorProps {
  fieldName: string;
  condition: FieldCondition | undefined;
  candidateTriggers: PydanticField[];
  onChange: (condition: FieldCondition | undefined) => void;
}

export function ConditionEditor({
  fieldName,
  condition,
  candidateTriggers,
  onChange,
}: ConditionEditorProps) {
  const enabled = !!condition;
  const op = currentOp(condition);
  const trigger: PydanticField | undefined = condition?.field
    ? candidateTriggers.find((c) => c.name === condition.field)
    : undefined;
  const supportsValues = !!trigger?.options && trigger.options.length > 0;

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs">Exibição condicional</Label>
          <p className="text-xs text-muted-foreground">
            Só mostrar esta pergunta quando outra for respondida de certo jeito
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => {
            if (!checked) {
              onChange(undefined);
              return;
            }
            const first = candidateTriggers[0];
            if (!first) return;
            onChange({ field: first.name, equals: first.options?.[0] ?? "" });
          }}
          disabled={candidateTriggers.length === 0}
        />
      </div>

      {candidateTriggers.length === 0 && !enabled && (
        <p className="text-xs text-muted-foreground">
          Adicione ao menos um campo de escolha antes deste para poder criar uma condição.
        </p>
      )}

      {enabled && condition && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Se</span>
          <Select
            value={condition.field}
            onValueChange={(value) => {
              const newTrigger = candidateTriggers.find((c) => c.name === value);
              const firstOpt = newTrigger?.options?.[0] ?? "";
              onChange({ field: value, equals: firstOpt });
            }}
          >
            <SelectTrigger className="h-8 min-w-[160px] text-xs">
              <SelectValue placeholder="campo" />
            </SelectTrigger>
            <SelectContent>
              {candidateTriggers.map((c) => (
                <SelectItem key={c.name} value={c.name} className="text-xs">
                  <span className="font-mono">{c.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={op ?? "equals"}
            onValueChange={(value) =>
              onChange(buildCondition(value as Op, condition.field, condition))
            }
          >
            <SelectTrigger className="h-8 min-w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(OP_LABELS) as [Op, string][]).map(([value, label]) => (
                <SelectItem key={value} value={value} className="text-xs">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ValueControl
            condition={condition}
            trigger={trigger}
            onChange={onChange}
            supportsValues={supportsValues}
          />

          {fieldName && condition.field === fieldName && (
            <p className="text-xs text-destructive w-full">
              Condição não pode referenciar o próprio campo.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface ValueControlProps {
  condition: FieldCondition;
  trigger: PydanticField | undefined;
  supportsValues: boolean;
  onChange: (condition: FieldCondition | undefined) => void;
}

function ValueControl({
  condition,
  trigger,
  supportsValues,
  onChange,
}: ValueControlProps) {
  if ("exists" in condition) {
    return (
      <div className="flex items-center gap-2">
        <Select
          value={condition.exists ? "yes" : "no"}
          onValueChange={(value) =>
            onChange({ field: condition.field, exists: value === "yes" })
          }
        >
          <SelectTrigger className="h-8 min-w-[120px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="yes" className="text-xs">
              sim
            </SelectItem>
            <SelectItem value="no" className="text-xs">
              não
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  }

  if ("in" in condition || "not_in" in condition) {
    const op: "in" | "not_in" = "in" in condition ? "in" : "not_in";
    const values = (
      "in" in condition ? condition.in : condition.not_in
    ) as string[];
    if (!supportsValues) {
      return (
        <span className="text-xs text-muted-foreground">
          (campo gatilho não tem opções)
        </span>
      );
    }
    return (
      <div className="flex flex-wrap gap-1">
        {trigger?.options?.map((opt) => {
          const checked = values.includes(opt);
          return (
            <label
              key={opt}
              className={cn(
                "flex items-center gap-1 rounded border px-2 py-1 text-xs cursor-pointer",
                checked
                  ? "bg-brand/10 text-brand border-brand/40"
                  : "border-border bg-background",
              )}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(next) => {
                  const nextValues = next
                    ? [...values, opt]
                    : values.filter((v) => v !== opt);
                  onChange(
                    op === "in"
                      ? { field: condition.field, in: nextValues }
                      : { field: condition.field, not_in: nextValues },
                  );
                }}
                className="h-3 w-3"
              />
              <span>{opt}</span>
            </label>
          );
        })}
      </div>
    );
  }

  const scalar =
    "equals" in condition
      ? condition.equals
      : condition.not_equals;
  const isEquals = "equals" in condition;

  if (!supportsValues) {
    return (
      <span className="text-xs text-muted-foreground">
        (campo gatilho não tem opções)
      </span>
    );
  }

  return (
    <Select
      value={String(scalar ?? "")}
      onValueChange={(value) =>
        onChange(
          isEquals
            ? { field: condition.field, equals: value }
            : { field: condition.field, not_equals: value },
        )
      }
    >
      <SelectTrigger className="h-8 min-w-[140px] text-xs">
        <SelectValue placeholder="valor" />
      </SelectTrigger>
      <SelectContent>
        {trigger?.options?.map((opt) => (
          <SelectItem key={opt} value={opt} className="text-xs">
            {opt}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function candidateTriggersFor(
  fields: PydanticField[],
  currentFieldName: string,
): PydanticField[] {
  const out: PydanticField[] = [];
  for (const f of fields) {
    if (f.name === currentFieldName) break;
    // Only fields with options can be meaningfully used as triggers
    // (single/multi). For text/date, a user can still target via `exists`,
    // but for the initial UX we restrict triggers to option-bearing fields.
    if ((f.type === "single" || f.type === "multi") && f.options && f.options.length > 0) {
      out.push(f);
    }
  }
  return out;
}
