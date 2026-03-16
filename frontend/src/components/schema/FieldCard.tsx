"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { OptionsEditor } from "./OptionsEditor";
import type { PydanticField } from "@/lib/types";

interface FieldCardProps {
  field: PydanticField;
  index: number;
  total: number;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (field: PydanticField) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  single: "Escolha única",
  multi: "Múltipla escolha",
  text: "Texto livre",
};

const TYPE_COLORS: Record<string, string> = {
  single: "bg-blue-500/10 text-blue-700",
  multi: "bg-purple-500/10 text-purple-700",
  text: "bg-green-500/10 text-green-700",
};

const TARGET_LABELS: Record<string, string> = {
  llm_only: "Apenas LLM",
  human_only: "Apenas humano",
};

export function FieldCard({
  field,
  index,
  total,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: FieldCardProps) {
  const updateField = (patch: Partial<PydanticField>) => {
    onChange({ ...field, ...patch });
  };

  const handleTypeChange = (type: PydanticField["type"]) => {
    if (type === "text") {
      updateField({ type, options: null });
    } else if (!field.options || field.options.length === 0) {
      updateField({ type, options: ["Opção 1"] });
    } else {
      updateField({ type });
    }
  };

  const nameIsValid = /^[a-z_][a-z0-9_]*$/.test(field.name);

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <div
        className={cn(
          "rounded-lg border transition-colors",
          isExpanded ? "border-brand/40 bg-card" : "border-border bg-card"
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Setas de reordenação */}
          <div className="flex flex-col -space-y-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              disabled={index === 0}
              onClick={onMoveUp}
            >
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              disabled={index === total - 1}
              onClick={onMoveDown}
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
          </div>

          {/* Nome + badges */}
          <CollapsibleTrigger asChild>
            <button className="flex flex-1 items-center gap-2 text-left min-w-0">
              <code className="text-sm font-mono truncate">{field.name}</code>
              <Badge className={cn("text-xs shrink-0", TYPE_COLORS[field.type])}>
                {TYPE_LABELS[field.type]}
              </Badge>
              {field.target && field.target !== "all" && (
                <Badge className="text-xs shrink-0 bg-amber-500/10 text-amber-700">
                  {TARGET_LABELS[field.target]}
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
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Body expandido */}
        <CollapsibleContent>
          <div className="border-t px-4 py-4 space-y-4">
            {/* Nome do campo */}
            <div className="space-y-1.5">
              <Label className="text-xs">Nome do campo</Label>
              <Input
                value={field.name}
                onChange={(e) => updateField({ name: e.target.value })}
                placeholder="nome_do_campo"
                className={cn(
                  "font-mono text-sm h-8",
                  !nameIsValid && field.name && "border-destructive"
                )}
              />
              {!nameIsValid && field.name && (
                <p className="text-xs text-destructive">
                  Use apenas letras minúsculas, números e _ (ex: tipo_documento)
                </p>
              )}
            </div>

            {/* Descrição */}
            <div className="space-y-1.5">
              <Label className="text-xs">
                Descrição (visível para pesquisadores)
              </Label>
              <Input
                value={field.description}
                onChange={(e) => updateField({ description: e.target.value })}
                placeholder="O que este campo representa?"
                className="text-sm h-8"
              />
            </div>

            {/* Tipo */}
            <div className="space-y-1.5">
              <Label className="text-xs">Tipo de resposta</Label>
              <div className="flex gap-1">
                {(["single", "multi", "text"] as const).map((t) => (
                  <Button
                    key={t}
                    variant="outline"
                    size="sm"
                    className={cn(
                      "text-xs",
                      field.type === t &&
                        "bg-brand/10 text-brand border-brand/40"
                    )}
                    onClick={() => handleTypeChange(t)}
                  >
                    {TYPE_LABELS[t]}
                  </Button>
                ))}
              </div>
            </div>

            {/* Destino */}
            <div className="space-y-1.5">
              <Label className="text-xs">Quem responde</Label>
              <div className="flex gap-1">
                {(
                  [
                    ["all", "Todos"],
                    ["llm_only", "Apenas LLM"],
                    ["human_only", "Apenas humano"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    variant="outline"
                    size="sm"
                    className={cn(
                      "text-xs",
                      (field.target || "all") === value &&
                        "bg-brand/10 text-brand border-brand/40"
                    )}
                    onClick={() => updateField({ target: value })}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Opções (só para single/multi) */}
            {(field.type === "single" || field.type === "multi") && (
              <div className="space-y-1.5">
                <Label className="text-xs">Opções</Label>
                <OptionsEditor
                  options={field.options || []}
                  onChange={(opts) => updateField({ options: opts })}
                />
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
