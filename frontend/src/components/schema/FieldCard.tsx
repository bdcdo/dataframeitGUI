"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { GripVertical, Trash2 } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { OptionsEditor } from "./OptionsEditor";
import { ConditionEditor, candidateTriggersFor } from "./ConditionEditor";
import { RemoveOptionDialog } from "./RemoveOptionDialog";
import {
  findConditionConflicts,
  stripOptionFromConditions,
  type ConditionConflict,
} from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";

interface FieldCardProps {
  id: string;
  field: PydanticField;
  allFields: PydanticField[];
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (field: PydanticField) => void;
  onRemove: () => void;
  // Opcional: callback para substituir TODA a lista de campos. Usado quando
  // remover uma opção exige também atualizar `condition` de outros campos.
  onAllFieldsChange?: (fields: PydanticField[]) => void;
}

const TYPE_LABELS: Record<string, string> = {
  single: "Escolha única",
  multi: "Múltipla escolha",
  text: "Texto livre",
  date: "Data",
};

const TYPE_COLORS: Record<string, string> = {
  single: "bg-blue-500/10 text-blue-700",
  multi: "bg-purple-500/10 text-purple-700",
  text: "bg-green-500/10 text-green-700",
  date: "bg-amber-500/10 text-amber-700",
};

const TARGET_LABELS: Record<string, string> = {
  llm_only: "Apenas LLM",
  human_only: "Apenas humano",
  none: "Oculto",
};

export function FieldCard({
  id,
  field,
  allFields,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
  onAllFieldsChange,
}: FieldCardProps) {
  const updateField = (patch: Partial<PydanticField>) => {
    onChange({ ...field, ...patch });
  };

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const [pendingRemoval, setPendingRemoval] = useState<{
    option: string;
    conflicts: ConditionConflict[];
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  const handleBeforeRemoveOption = async (opt: string): Promise<boolean> => {
    if (!onAllFieldsChange) return true;
    const conflicts = findConditionConflicts(allFields, field.name, opt);
    if (conflicts.length === 0) return true;

    const confirmed = await new Promise<boolean>((resolve) => {
      setPendingRemoval({ option: opt, conflicts, resolve });
    });

    if (!confirmed) return false;

    const stripped = stripOptionFromConditions(allFields, field.name, opt);
    const filteredOpts = (field.options || []).filter((o) => o !== opt);
    const final = stripped.map((f) =>
      f.name === field.name
        ? { ...f, options: filteredOpts.length > 0 ? filteredOpts : null }
        : f,
    );
    onAllFieldsChange(final);
    return false; // já aplicado pelo onAllFieldsChange
  };

  const handleTypeChange = (type: PydanticField["type"]) => {
    if (type === "text") {
      updateField({ type, options: null });
    } else if (type === "date") {
      // Preserve existing options when switching to date — they become
      // sentinels rendered alongside the date picker (ex: "Não identificável").
      updateField({ type });
    } else if (!field.options || field.options.length === 0) {
      updateField({ type, options: ["Opção 1"] });
    } else {
      updateField({ type });
    }
  };

  const nameIsValid = /^[a-z_][a-z0-9_]*$/.test(field.name);

  return (
    <div ref={setNodeRef} style={sortableStyle}>
      <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <div
        className={cn(
          "rounded-lg border transition-colors",
          isExpanded ? "border-brand/40 bg-card" : "border-border bg-card"
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Drag handle */}
          <button
            type="button"
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground touch-none",
              isDragging ? "cursor-grabbing" : "cursor-grab"
            )}
            aria-label="Arrastar para reordenar"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>

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
              {field.required === false && (
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

            {/* Texto de ajuda */}
            <div className="space-y-1.5">
              <Label className="text-xs">
                Instruções complementares (opcional)
              </Label>
              <Textarea
                value={field.help_text || ""}
                onChange={(e) => updateField({ help_text: e.target.value || undefined })}
                onBlur={(e) => updateField({ help_text: e.target.value.trim() || undefined })}
                placeholder="Explicações adicionais sobre como responder esta pergunta"
                className="text-sm min-h-[60px] resize-y"
              />
            </div>

            {/* Tipo */}
            <div className="space-y-1.5">
              <Label className="text-xs">Tipo de resposta</Label>
              <div className="flex gap-1">
                {(["single", "multi", "text", "date"] as const).map((t) => (
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
              <div className="flex gap-1 flex-wrap">
                {(
                  [
                    ["all", "Todos"],
                    ["llm_only", "Apenas LLM"],
                    ["human_only", "Apenas humano"],
                    ["none", "Oculto (ninguém vê)"],
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
                    onClick={() =>
                      // Sair do escopo LLM (human_only/none) limpa o prompt de
                      // justificativa junto — o input some e o valor não ficaria
                      // editável nem visível. Mesmo padrão de handleTypeChange.
                      updateField(
                        value === "human_only" || value === "none"
                          ? { target: value, justification_prompt: undefined }
                          : { target: value },
                      )
                    }
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Obrigatório (não faz sentido para llm_only nem oculto) */}
            {(field.target || "all") !== "llm_only" && field.target !== "none" && (
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-xs">Obrigatório</Label>
                  <p className="text-xs text-muted-foreground">
                    Campos opcionais não bloqueiam a conclusão da tarefa
                  </p>
                </div>
                <Switch
                  checked={field.required !== false}
                  onCheckedChange={(checked) =>
                    updateField({ required: checked ? undefined : false })
                  }
                />
              </div>
            )}

            {/* Opções (single/multi) ou Respostas padronizadas (text) */}
            {(field.type === "single" || field.type === "multi") && (
              <div className="space-y-1.5">
                <Label className="text-xs">Opções</Label>
                <OptionsEditor
                  options={field.options || []}
                  onChange={(opts) => updateField({ options: opts })}
                  onBeforeRemove={handleBeforeRemoveOption}
                />
              </div>
            )}
            {field.type === "date" && (
              <div className="space-y-1.5">
                <Label className="text-xs">Valores sentinela (opcional)</Label>
                <p className="text-xs text-muted-foreground">
                  Aparecem como botões ao lado do campo de data (ex: &quot;Não identificável&quot;).
                </p>
                <OptionsEditor
                  options={field.options || []}
                  onChange={(opts) =>
                    updateField({ options: opts.length > 0 ? opts : null })
                  }
                  onBeforeRemove={handleBeforeRemoveOption}
                />
              </div>
            )}
            {(field.type === "single" || field.type === "multi") && (
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-xs">Permitir &quot;Outro: ...&quot;</Label>
                  <p className="text-xs text-muted-foreground">
                    Pesquisador pode digitar um valor livre além das opções acima
                  </p>
                </div>
                <Switch
                  checked={field.allow_other === true}
                  onCheckedChange={(checked) =>
                    updateField({ allow_other: checked ? true : undefined })
                  }
                />
              </div>
            )}
            {field.type === "text" && (
              <div className="space-y-3">
                {/* Toggle subcampos */}
                <div className="flex items-center gap-2">
                  <Switch
                    checked={!!field.subfields && field.subfields.length > 0}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        updateField({
                          subfields: [
                            { key: "campo_1", label: "Campo 1", required: true },
                            { key: "campo_2", label: "Campo 2", required: true },
                          ],
                          subfield_rule: "all",
                          options: null,
                        });
                      } else {
                        updateField({ subfields: undefined, subfield_rule: undefined });
                      }
                    }}
                  />
                  <Label className="text-xs">Dividir em subcampos</Label>
                </div>

                {field.subfields && field.subfields.length > 0 ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs">Regra</Label>
                      <div className="flex gap-1">
                        {(
                          [
                            ["all", "Todos os obrigatórios"],
                            ["at_least_one", "Pelo menos um"],
                          ] as const
                        ).map(([value, label]) => (
                          <Button
                            key={value}
                            variant="outline"
                            size="sm"
                            className={cn(
                              "text-xs h-6",
                              (field.subfield_rule || "all") === value &&
                                "bg-brand/10 text-brand border-brand/40"
                            )}
                            onClick={() => updateField({ subfield_rule: value })}
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    </div>
                    {field.subfields.map((sf, si) => (
                      <div key={si} className="flex items-center gap-1.5">
                        <Input
                          value={sf.key}
                          onChange={(e) => {
                            const sfs = [...field.subfields!];
                            sfs[si] = { ...sfs[si], key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") };
                            updateField({ subfields: sfs });
                          }}
                          className="w-28 font-mono text-xs h-7"
                          placeholder="chave"
                        />
                        <Input
                          value={sf.label}
                          onChange={(e) => {
                            const sfs = [...field.subfields!];
                            sfs[si] = { ...sfs[si], label: e.target.value };
                            updateField({ subfields: sfs });
                          }}
                          className="flex-1 text-xs h-7"
                          placeholder="Label visível"
                        />
                        {field.subfield_rule !== "at_least_one" && (
                          <div className="flex items-center gap-1">
                            <Switch
                              checked={sf.required !== false}
                              onCheckedChange={(checked) => {
                                const sfs = [...field.subfields!];
                                sfs[si] = { ...sfs[si], required: checked };
                                updateField({ subfields: sfs });
                              }}
                            />
                            <span className="text-[10px] text-muted-foreground">Obrig.</span>
                          </div>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => {
                            const sfs = field.subfields!.filter((_, j) => j !== si);
                            updateField({ subfields: sfs.length > 0 ? sfs : undefined, subfield_rule: sfs.length > 0 ? field.subfield_rule : undefined });
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs h-6"
                      onClick={() => {
                        const idx = field.subfields!.length + 1;
                        updateField({
                          subfields: [
                            ...field.subfields!,
                            { key: `campo_${idx}`, label: `Campo ${idx}`, required: true },
                          ],
                        });
                      }}
                    >
                      + Adicionar subcampo
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Respostas padronizadas (opcional)</Label>
                    <p className="text-xs text-muted-foreground">
                      Botões de atalho para respostas comuns — garante consistência na comparação
                    </p>
                    <OptionsEditor
                      options={field.options || []}
                      onChange={(opts) => updateField({ options: opts.length > 0 ? opts : null })}
                      onBeforeRemove={handleBeforeRemoveOption}
                    />
                  </div>
                )}
              </div>
            )}

            <ConditionEditor
              fieldName={field.name}
              condition={field.condition}
              candidateTriggers={candidateTriggersFor(allFields, field.name)}
              onChange={(condition) => updateField({ condition })}
            />

            {/* Prompt de justificativa do LLM — só faz sentido quando o campo
                é enviado ao LLM. Vazio = backend usa o default exigente. */}
            {(field.target || "all") !== "human_only" &&
              field.target !== "none" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Prompt de justificativa do LLM (opcional)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Texto-base que o LLM recebe ao justificar este campo. Em
                    branco, usa o default que exige citação textual do trecho
                    do documento. <code>{"{name}"}</code> é a única chave
                    substituída (vira o nome do campo); qualquer outra chave
                    entre chaves faz o texto ser usado literalmente, sem
                    substituição.
                  </p>
                  <Textarea
                    value={field.justification_prompt || ""}
                    onChange={(e) =>
                      updateField({
                        justification_prompt: e.target.value || undefined,
                      })
                    }
                    onBlur={(e) =>
                      updateField({
                        justification_prompt:
                          e.target.value.trim() || undefined,
                      })
                    }
                    placeholder="Ex.: Cite o trecho do parecer e explique como ele leva à resposta."
                    className="text-sm min-h-[60px] resize-y"
                  />
                </div>
              )}
          </div>
        </CollapsibleContent>
      </div>

      {pendingRemoval && (
        <RemoveOptionDialog
          open
          onOpenChange={(open) => {
            if (!open && pendingRemoval) {
              pendingRemoval.resolve(false);
              setPendingRemoval(null);
            }
          }}
          option={pendingRemoval.option}
          conflicts={pendingRemoval.conflicts}
          onConfirm={() => {
            pendingRemoval.resolve(true);
            setPendingRemoval(null);
          }}
        />
      )}
      </Collapsible>
    </div>
  );
}
