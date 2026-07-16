"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { ConditionEditor } from "./ConditionEditor";
import { candidateTriggersFor } from "@/lib/conditional";
import { RemoveOptionDialog } from "./RemoveOptionDialog";
import { FieldCardHeader } from "./FieldCardHeader";
import { TYPE_LABELS } from "@/lib/field-labels";
import { SubfieldsEditor } from "./SubfieldsEditor";
import { JustificationPromptField } from "./JustificationPromptField";
import { OptionsAllowOtherEditor } from "./OptionsAllowOtherEditor";
import { DateSentinelEditor } from "./DateSentinelEditor";
import { useOptionRemovalGuard } from "./useOptionRemovalGuard";
import { stripOptionFromConditions } from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";
import { pydanticFieldNameIssue } from "@/lib/pydantic-field";

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

function FieldNameInput({
  field,
  allFields,
  onChange,
}: {
  field: PydanticField;
  allFields: PydanticField[];
  onChange: (name: string) => void;
}) {
  const [duplicateName, setDuplicateName] = useState(false);
  const nameIssue = pydanticFieldNameIssue(field.name);
  const handleChange = (name: string) => {
    const duplicate = allFields.some(
      (candidate) => candidate !== field && candidate.name === name,
    );
    setDuplicateName(duplicate);
    if (!duplicate) onChange(name);
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Nome do campo</Label>
      <Input
        value={field.name}
        onChange={(event) => handleChange(event.target.value)}
        placeholder="nome_do_campo"
        className={cn(
          "font-mono text-sm h-8",
          nameIssue && field.name && "border-destructive",
        )}
      />
      {nameIssue === "invalid" && field.name && (
        <p className="text-xs text-destructive">
          Use apenas letras minúsculas, números e _ (ex: tipo_documento)
        </p>
      )}
      {nameIssue === "reserved" && (
        <p className="text-xs text-destructive">
          Nomes que começam e terminam com __ são reservados pelo Python.
        </p>
      )}
      {duplicateName && (
        <p className="text-xs text-destructive">
          Já existe um campo com esse nome.
        </p>
      )}
    </div>
  );
}

type UpdateField = (patch: Partial<PydanticField>) => void;

function fieldTypePatch(
  field: PydanticField,
  type: PydanticField["type"],
): Partial<PydanticField> {
  if (type === "text") return { type, options: null };
  if (type === "date") return { type };
  if (!field.options?.length) return { type, options: ["Opção 1"] };
  return { type };
}

function FieldTypeControls({
  field,
  updateField,
}: {
  field: PydanticField;
  updateField: UpdateField;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Tipo de resposta</Label>
      <div className="flex gap-1">
        {(["single", "multi", "text", "date"] as const).map((type) => (
          <Button
            key={type}
            variant="outline"
            size="sm"
            className={cn(
              "text-xs",
              field.type === type && "bg-brand/10 text-brand border-brand/40",
            )}
            onClick={() => updateField(fieldTypePatch(field, type))}
          >
            {TYPE_LABELS[type]}
          </Button>
        ))}
      </div>
    </div>
  );
}

function FieldTargetControls({
  field,
  updateField,
}: {
  field: PydanticField;
  updateField: UpdateField;
}) {
  const target = field.target || "all";
  return (
    <>
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
                target === value && "bg-brand/10 text-brand border-brand/40",
              )}
              onClick={() =>
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

      {target !== "llm_only" && target !== "none" && (
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
    </>
  );
}

function FieldAnswerEditors({
  field,
  allFields,
  updateField,
  onBeforeRemoveOption,
}: {
  field: PydanticField;
  allFields: PydanticField[];
  updateField: UpdateField;
  onBeforeRemoveOption: (option: string) => Promise<boolean>;
}) {
  const options = field.options ?? [];
  const isChoiceField = ["single", "multi"].includes(field.type);
  const target = field.target ?? "all";
  return (
    <>
      {isChoiceField && (
        <OptionsAllowOtherEditor
          options={options}
          onChange={(options) => updateField({ options })}
          onBeforeRemoveOption={onBeforeRemoveOption}
          allowOther={field.allow_other === true}
          onAllowOtherChange={(checked) =>
            updateField({ allow_other: checked ? true : undefined })
          }
        />
      )}
      {field.type === "date" && (
        <DateSentinelEditor
          options={options}
          onChange={(options) =>
            updateField({ options: options.length > 0 ? options : null })
          }
          onBeforeRemoveOption={onBeforeRemoveOption}
        />
      )}
      {field.type === "text" && (
        <SubfieldsEditor
          subfields={field.subfields}
          subfieldRule={field.subfield_rule}
          options={options}
          onChange={updateField}
          onBeforeRemoveOption={onBeforeRemoveOption}
        />
      )}

      <ConditionEditor
        fieldName={field.name}
        condition={field.condition}
        candidateTriggers={candidateTriggersFor(allFields, field.name)}
        onChange={(condition) => updateField({ condition })}
      />

      {target !== "human_only" && target !== "none" && (
        <JustificationPromptField
          value={field.justification_prompt || ""}
          onChange={(value) =>
            updateField({ justification_prompt: value || undefined })
          }
          onBlur={(value) =>
            updateField({ justification_prompt: value.trim() || undefined })
          }
        />
      )}
    </>
  );
}

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

  const { confirmRemoval, dialogProps } = useOptionRemovalGuard(
    allFields,
    field.name,
  );

  const handleBeforeRemoveOption = async (opt: string): Promise<boolean> => {
    if (!onAllFieldsChange) return true;
    const { confirmed, conflicts } = await confirmRemoval(opt);
    if (conflicts.length === 0) return true;
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

  return (
    <div ref={setNodeRef} style={sortableStyle}>
      <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <div
        className={cn(
          "rounded-lg border transition-colors",
          isExpanded ? "border-brand/40 bg-card" : "border-border bg-card"
        )}
      >
        <FieldCardHeader
          field={field}
          isDragging={isDragging}
          dragHandleProps={{ ...attributes, ...listeners }}
          onRemove={onRemove}
        />

        {/* Body expandido */}
        <CollapsibleContent>
          <div className="border-t p-4 space-y-4">
            {/* Nome do campo */}
            <FieldNameInput
              field={field}
              allFields={allFields}
              onChange={(name) => updateField({ name })}
            />

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

            <FieldTypeControls field={field} updateField={updateField} />
            <FieldTargetControls field={field} updateField={updateField} />
            <FieldAnswerEditors
              field={field}
              allFields={allFields}
              updateField={updateField}
              onBeforeRemoveOption={handleBeforeRemoveOption}
            />
          </div>
        </CollapsibleContent>
      </div>

      {dialogProps && <RemoveOptionDialog open {...dialogProps} />}
      </Collapsible>
    </div>
  );
}
