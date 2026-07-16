"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Loader2 } from "lucide-react";
import { ConditionEditor } from "@/components/schema/ConditionEditor";
import { candidateTriggersFor } from "@/lib/conditional";
import { RemoveOptionDialog } from "@/components/schema/RemoveOptionDialog";
import { SubfieldsEditor } from "@/components/schema/SubfieldsEditor";
import { JustificationPromptField } from "@/components/schema/JustificationPromptField";
import { OptionsAllowOtherEditor } from "@/components/schema/OptionsAllowOtherEditor";
import { DateSentinelEditor } from "@/components/schema/DateSentinelEditor";
import { useOptionRemovalGuard } from "@/components/schema/useOptionRemovalGuard";
import { TYPE_LABELS } from "@/lib/field-labels";
import { stripOptionFromConditions } from "@/lib/schema-utils";
import { saveSchemaFromGUI } from "@/actions/schema";
import { approveSchemaSuggestionWithEdits } from "@/actions/suggestions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useEditFieldForm, type PendingSuggestion } from "./useEditFieldForm";
import type { PydanticField, SchemaBaselineIdentity } from "@/lib/types";

export type { PendingSuggestion };

interface EditFieldDialogProps {
  projectId: string;
  fieldName: string;
  allFields: PydanticField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingSuggestion?: PendingSuggestion | null;
  schemaBaseline: SchemaBaselineIdentity;
}

export function EditFieldDialog({
  projectId,
  fieldName,
  allFields,
  open,
  onOpenChange,
  pendingSuggestion,
  schemaBaseline,
}: EditFieldDialogProps) {
  const { refresh } = useRouter();
  const field = allFields.find((f) => f.name === fieldName);
  const {
    description,
    setDescription,
    helpText,
    setHelpText,
    options,
    setOptions,
    allowOther,
    setAllowOther,
    subfields,
    setSubfields,
    subfieldRule,
    setSubfieldRule,
    condition,
    setCondition,
    justificationPrompt,
    setJustificationPrompt,
    isSaving,
    startSave,
  } = useEditFieldForm(field, fieldName, allFields, pendingSuggestion);

  const { confirmRemoval, dialogProps } = useOptionRemovalGuard(
    allFields,
    fieldName,
  );
  const handleBeforeRemoveOption = async (opt: string): Promise<boolean> =>
    (await confirmRemoval(opt)).confirmed;

  if (!field) return null;

  const descriptionChanged = description !== field.description;
  const hasSubfields = subfields && subfields.length > 0;

  const handleSave = () => {
    startSave(async () => {
      const originalOpts = field.options ?? [];
      const removedOpts = originalOpts.filter((o) => !options.includes(o));
      let updatedFields = allFields.map((f) =>
        f.name === fieldName
          ? {
              ...f,
              description,
              help_text: helpText.trim() || undefined,
              options: hasSubfields ? null : (options.length > 0 ? options : null),
              subfields: hasSubfields ? subfields : undefined,
              subfield_rule: hasSubfields ? subfieldRule : undefined,
              allow_other:
                (f.type === "single" || f.type === "multi") && allowOther
                  ? true
                  : undefined,
              condition,
              justification_prompt: justificationPrompt.trim() || undefined,
            }
          : f,
      );
      for (const removed of removedOpts) {
        updatedFields = stripOptionFromConditions(updatedFields, fieldName, removed);
      }
      try {
        if (pendingSuggestion) {
          const result = await approveSchemaSuggestionWithEdits(
            pendingSuggestion.id,
            projectId,
            updatedFields,
            schemaBaseline,
          );
          if (result.error) throw new Error(result.error);
          toast.success("Sugestão aprovada e campo atualizado");
        } else {
          const result = await saveSchemaFromGUI(
            projectId,
            updatedFields,
            schemaBaseline,
          );
          if (result.status === "error") throw new Error(result.message);
          if (result.status === "conflict") {
            throw new Error(
              "O schema mudou em outra sessão. Recarregue a página e reaplique esta edição sobre a versão atual.",
            );
          }
          toast.success("Campo atualizado");
        }
        onOpenChange(false);
        refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Erro ao salvar",
        );
      }
    });
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {pendingSuggestion ? "Revisar sugestão" : "Editar campo"}
            <code className="text-sm font-mono text-muted-foreground">
              {fieldName}
            </code>
          </DialogTitle>
        </DialogHeader>
        {pendingSuggestion && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Os campos abaixo vêm da sugestão original. Ajuste o que for
              necessário e clique em Salvar para aprovar.
            </span>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Label className="text-xs">Tipo</Label>
            <Badge variant="outline" className="text-xs">
              {TYPE_LABELS[field.type]}
            </Badge>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              Descrição (visível para pesquisadores)
            </Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="O que este campo representa?"
              className="text-sm h-8"
            />
            {descriptionChanged && (
              <p className="flex items-center gap-1 text-xs text-amber-600">
                <AlertTriangle className="size-3" />
                Alterar a descrição marcará respostas existentes como
                desatualizadas
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              Instruções complementares (opcional)
            </Label>
            <Textarea
              value={helpText}
              onChange={(e) => setHelpText(e.target.value)}
              placeholder="Explicações adicionais"
              className="text-sm min-h-[60px] resize-y"
            />
          </div>

          {(field.type === "single" || field.type === "multi") && (
            <OptionsAllowOtherEditor
              options={options}
              onChange={setOptions}
              onBeforeRemoveOption={handleBeforeRemoveOption}
              allowOther={allowOther}
              onAllowOtherChange={setAllowOther}
            />
          )}

          {field.type === "date" && (
            <DateSentinelEditor
              options={options}
              onChange={setOptions}
              onBeforeRemoveOption={handleBeforeRemoveOption}
            />
          )}

          {field.type === "text" && (
            <SubfieldsEditor
              subfields={subfields}
              subfieldRule={subfieldRule}
              options={options}
              onChange={(patch) => {
                setSubfields(patch.subfields);
                setSubfieldRule(patch.subfield_rule ?? "all");
                setOptions(patch.options ?? []);
              }}
              onBeforeRemoveOption={handleBeforeRemoveOption}
            />
          )}

          <ConditionEditor
            fieldName={fieldName}
            condition={condition}
            candidateTriggers={candidateTriggersFor(allFields, fieldName)}
            onChange={setCondition}
          />

          {/* Prompt de justificativa do LLM — só faz sentido quando o campo
              é enviado ao LLM. Vazio = backend usa o default exigente. */}
          {(field.target || "all") !== "human_only" &&
            field.target !== "none" && (
              <JustificationPromptField
                value={justificationPrompt}
                onChange={setJustificationPrompt}
              />
            )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button size="sm" disabled={isSaving || !description.trim()} onClick={handleSave}>
            {isSaving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {dialogProps && <RemoveOptionDialog open {...dialogProps} />}
    </>
  );
}
