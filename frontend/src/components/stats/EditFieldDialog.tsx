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
import { saveSchemaFromGUI } from "@/actions/schema";
import { approveSchemaSuggestionWithEdits } from "@/actions/suggestions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useEditFieldForm, type PendingSuggestion } from "./useEditFieldForm";
import {
  applyFormEdits,
  saveMergedEdit,
  type SubmitOutcome,
} from "./edit-field-save";
import type { PydanticField, SchemaBaselineIdentity } from "@/lib/types";
import { resolveTarget } from "@/lib/pydantic-field";

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

type EditFieldForm = ReturnType<typeof useEditFieldForm>;

// Editores específicos do tipo do campo (e das propriedades que só alguns
// tipos têm). Vive fora do componente principal porque os ramos por tipo são
// puramente declarativos e, somados ao fluxo de save, punham o `EditFieldDialog`
// acima do limiar de complexidade cognitiva do gate do fallow. Não há
// code-splitting envolvido: é o mesmo módulo e a mesma árvore renderizada.
function FieldTypeEditors({
  form,
  baseField,
  fieldName,
  allFields,
  onBeforeRemoveOption,
}: {
  form: EditFieldForm;
  baseField: PydanticField;
  fieldName: string;
  allFields: PydanticField[];
  onBeforeRemoveOption: (opt: string) => Promise<boolean>;
}) {
  return (
    <>
      {(baseField.type === "single" || baseField.type === "multi") && (
        <OptionsAllowOtherEditor
          options={form.options}
          onChange={form.setOptions}
          onBeforeRemoveOption={onBeforeRemoveOption}
          allowOther={form.allowOther}
          onAllowOtherChange={form.setAllowOther}
        />
      )}

      {baseField.type === "date" && (
        <DateSentinelEditor
          options={form.options}
          onChange={form.setOptions}
          onBeforeRemoveOption={onBeforeRemoveOption}
        />
      )}

      {baseField.type === "text" && (
        <SubfieldsEditor
          subfields={form.subfields}
          subfieldRule={form.subfieldRule}
          options={form.options}
          onChange={(patch) => {
            form.setSubfields(patch.subfields);
            form.setSubfieldRule(patch.subfield_rule ?? "all");
            form.setOptions(patch.options ?? []);
          }}
          onBeforeRemoveOption={onBeforeRemoveOption}
        />
      )}

      <ConditionEditor
        fieldName={fieldName}
        condition={form.condition}
        candidateTriggers={candidateTriggersFor(allFields, fieldName)}
        onChange={form.setCondition}
      />

      {/* Prompt de justificativa do LLM — só faz sentido quando o campo
          é enviado ao LLM. Vazio = backend usa o default exigente. */}
      {resolveTarget(baseField.target) !== "human_only" &&
        resolveTarget(baseField.target) !== "none" && (
          <JustificationPromptField
            value={form.justificationPrompt}
            onChange={form.setJustificationPrompt}
          />
        )}
    </>
  );
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
  const form = useEditFieldForm(fieldName, allFields, pendingSuggestion);
  const {
    baseFields,
    baseField,
    description,
    setDescription,
    helpText,
    setHelpText,
    options,
    allowOther,
    subfields,
    subfieldRule,
    condition,
    justificationPrompt,
    isSaving,
    startSave,
  } = form;

  // A guarda de remoção é a única coisa aqui que fica no `allFields` VIVO, e é
  // intencional: ela pergunta "quais condições quebram se esta opção sair", e a
  // resposta útil é sobre as condições que existem AGORA — inclusive uma criada
  // em outra sessão depois que o diálogo abriu. Ancorá-la no base capturado
  // esconderia exatamente a dependência que o usuário não tem como ver.
  //
  // A contrapartida é que o strip de `applyFormEdits` roda sobre o base, então
  // uma condição que só existe no remoto sobrevive apontando para a opção
  // removida. O save recusa isso (`validateConditionValues` em pydantic-field),
  // então é fail-closed e não schema inconsistente — mas a mensagem culpa o
  // campo, não a concorrência. Ver issue #599.
  const { confirmRemoval, dialogProps } = useOptionRemovalGuard(
    allFields,
    fieldName,
  );
  const handleBeforeRemoveOption = async (opt: string): Promise<boolean> =>
    (await confirmRemoval(opt)).confirmed;

  // O campo pode ter sido deletado remotamente com o diálogo aberto; o form
  // segue ancorado no base capturado e o merge do save expõe o edit-delete.
  if (!baseField) return null;

  const descriptionChanged = description !== baseField.description;

  const submit = async (
    fields: PydanticField[],
    baseline: SchemaBaselineIdentity,
  ): Promise<SubmitOutcome> => {
    if (!pendingSuggestion) return saveSchemaFromGUI(projectId, fields, baseline);
    const result = await approveSchemaSuggestionWithEdits(
      pendingSuggestion.id,
      projectId,
      fields,
      baseline,
    );
    if (result.conflict) return { status: "conflict", current: result.conflict };
    if (result.error) return { status: "error", message: result.error };
    return { status: "saved" };
  };

  const handleSave = () => {
    startSave(async () => {
      try {
        const localFields = applyFormEdits(baseFields, fieldName, {
          description,
          helpText,
          options,
          allowOther,
          subfields,
          subfieldRule,
          condition,
          justificationPrompt,
        });
        const saved = await saveMergedEdit(
          baseFields,
          localFields,
          allFields,
          schemaBaseline,
          submit,
        );
        // Bloqueio e erro chegam pelo mesmo canal e param o save do mesmo jeito:
        // o diálogo fica aberto com a digitação intacta. O `catch` abaixo passa a
        // cuidar só do inesperado (queda de rede, exceção de Server Action).
        if (saved.status !== "saved") {
          toast.error(saved.message);
          return;
        }
        toast.success(
          pendingSuggestion
            ? "Sugestão aprovada e campo atualizado"
            : "Campo atualizado",
        );
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
              {TYPE_LABELS[baseField.type]}
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

          <FieldTypeEditors
            form={form}
            baseField={baseField}
            fieldName={fieldName}
            allFields={allFields}
            onBeforeRemoveOption={handleBeforeRemoveOption}
          />
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
