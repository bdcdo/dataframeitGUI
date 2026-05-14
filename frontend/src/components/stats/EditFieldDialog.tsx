"use client";

import { useState, useTransition } from "react";
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
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { OptionsEditor } from "@/components/schema/OptionsEditor";
import {
  ConditionEditor,
  candidateTriggersFor,
} from "@/components/schema/ConditionEditor";
import { RemoveOptionDialog } from "@/components/schema/RemoveOptionDialog";
import {
  findConditionConflicts,
  stripOptionFromConditions,
  type ConditionConflict,
} from "@/lib/schema-utils";
import { saveSchemaFromGUI } from "@/actions/schema";
import { approveSchemaSuggestionWithEdits } from "@/actions/suggestions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import type { FieldCondition, PydanticField, SubfieldDef } from "@/lib/types";

const TYPE_LABELS: Record<string, string> = {
  single: "Escolha única",
  multi: "Múltipla escolha",
  text: "Texto livre",
  date: "Data",
};

export interface PendingSuggestion {
  id: string;
  changes: {
    description?: string;
    help_text?: string | null;
    options?: string[] | null;
  };
}

interface EditFieldDialogProps {
  projectId: string;
  fieldName: string;
  allFields: PydanticField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pendingSuggestion?: PendingSuggestion | null;
}

function initialFromField(
  field: PydanticField | undefined,
  suggestion?: PendingSuggestion | null,
) {
  const ch = suggestion?.changes ?? {};
  // Distinguish "no change" (undefined) from "clear" (null) in suggestions:
  // null in suggested_changes means the suggestion explicitly wants to empty
  // the field, so ?? against the current field value would mask that intent.
  return {
    description: ch.description ?? field?.description ?? "",
    helpText:
      ch.help_text !== undefined
        ? (ch.help_text ?? "")
        : (field?.help_text ?? ""),
    options:
      ch.options !== undefined
        ? (ch.options ?? [])
        : (field?.options ?? []),
  };
}

export function EditFieldDialog({
  projectId,
  fieldName,
  allFields,
  open,
  onOpenChange,
  pendingSuggestion,
}: EditFieldDialogProps) {
  const router = useRouter();
  const field = allFields.find((f) => f.name === fieldName);
  const initial = initialFromField(field, pendingSuggestion);
  const [description, setDescription] = useState(initial.description);
  const [helpText, setHelpText] = useState(initial.helpText);
  const [options, setOptions] = useState<string[]>(initial.options);
  const [allowOther, setAllowOther] = useState<boolean>(field?.allow_other ?? false);
  const [subfields, setSubfields] = useState<SubfieldDef[] | undefined>(field?.subfields);
  const [subfieldRule, setSubfieldRule] = useState<"all" | "at_least_one">(field?.subfield_rule ?? "all");
  const [condition, setCondition] = useState<FieldCondition | undefined>(field?.condition);
  const [justificationPrompt, setJustificationPrompt] = useState<string>(
    field?.justification_prompt ?? "",
  );
  const [isSaving, startSave] = useTransition();
  const [pendingRemoval, setPendingRemoval] = useState<{
    option: string;
    conflicts: ConditionConflict[];
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  const handleBeforeRemoveOption = async (opt: string): Promise<boolean> => {
    const conflicts = findConditionConflicts(allFields, fieldName, opt);
    if (conflicts.length === 0) return true;
    return await new Promise<boolean>((resolve) => {
      setPendingRemoval({ option: opt, conflicts, resolve });
    });
  };

  // Reset state when dialog opens with a different field or suggestion
  const resetKey = `${fieldName}::${pendingSuggestion?.id ?? ""}`;
  const [prevKey, setPrevKey] = useState(resetKey);
  if (resetKey !== prevKey) {
    setPrevKey(resetKey);
    const f = allFields.find((ff) => ff.name === fieldName);
    const init = initialFromField(f, pendingSuggestion);
    setDescription(init.description);
    setHelpText(init.helpText);
    setOptions(init.options);
    setAllowOther(f?.allow_other ?? false);
    setSubfields(f?.subfields);
    setSubfieldRule(f?.subfield_rule ?? "all");
    setCondition(f?.condition);
    setJustificationPrompt(f?.justification_prompt ?? "");
  }

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
          );
          if (result.error) throw new Error(result.error);
          toast.success("Sugestão aprovada e campo atualizado");
        } else {
          await saveSchemaFromGUI(projectId, updatedFields);
          toast.success("Campo atualizado");
        }
        onOpenChange(false);
        router.refresh();
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
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
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
                <AlertTriangle className="h-3 w-3" />
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
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Opções</Label>
                <OptionsEditor
                  options={options}
                  onChange={setOptions}
                  onBeforeRemove={handleBeforeRemoveOption}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-xs">Permitir &quot;Outro: ...&quot;</Label>
                  <p className="text-xs text-muted-foreground">
                    Pesquisador pode digitar um valor livre além das opções acima
                  </p>
                </div>
                <Switch checked={allowOther} onCheckedChange={setAllowOther} />
              </div>
            </div>
          )}

          {field.type === "date" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Valores sentinela (opcional)</Label>
              <p className="text-xs text-muted-foreground">
                Aparecem como botões ao lado do campo de data (ex: &quot;Não identificável&quot;).
              </p>
              <OptionsEditor
                options={options}
                onChange={setOptions}
                onBeforeRemove={handleBeforeRemoveOption}
              />
            </div>
          )}

          {field.type === "text" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={!!hasSubfields}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setSubfields([
                        { key: "campo_1", label: "Campo 1", required: true },
                        { key: "campo_2", label: "Campo 2", required: true },
                      ]);
                      setSubfieldRule("all");
                      setOptions([]);
                    } else {
                      setSubfields(undefined);
                      setSubfieldRule("all");
                    }
                  }}
                />
                <Label className="text-xs">Dividir em subcampos</Label>
              </div>

              {hasSubfields ? (
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
                          className={`text-xs h-6 ${
                            subfieldRule === value
                              ? "bg-brand/10 text-brand border-brand/40"
                              : ""
                          }`}
                          onClick={() => setSubfieldRule(value)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </div>
                  {subfields!.map((sf, si) => (
                    <div key={si} className="flex items-center gap-1.5">
                      <Input
                        value={sf.key}
                        onChange={(e) => {
                          const sfs = [...subfields!];
                          sfs[si] = { ...sfs[si], key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") };
                          setSubfields(sfs);
                        }}
                        className="w-28 font-mono text-xs h-7"
                        placeholder="chave"
                      />
                      <Input
                        value={sf.label}
                        onChange={(e) => {
                          const sfs = [...subfields!];
                          sfs[si] = { ...sfs[si], label: e.target.value };
                          setSubfields(sfs);
                        }}
                        className="flex-1 text-xs h-7"
                        placeholder="Label visível"
                      />
                      {subfieldRule !== "at_least_one" && (
                        <div className="flex items-center gap-1">
                          <Switch
                            checked={sf.required !== false}
                            onCheckedChange={(checked) => {
                              const sfs = [...subfields!];
                              sfs[si] = { ...sfs[si], required: checked };
                              setSubfields(sfs);
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
                          const sfs = subfields!.filter((_, j) => j !== si);
                          setSubfields(sfs.length > 0 ? sfs : undefined);
                          if (sfs.length === 0) setSubfieldRule("all");
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
                      const idx = subfields!.length + 1;
                      setSubfields([
                        ...subfields!,
                        { key: `campo_${idx}`, label: `Campo ${idx}`, required: true },
                      ]);
                    }}
                  >
                    + Adicionar subcampo
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label className="text-xs">Respostas padronizadas (opcional)</Label>
                  <p className="text-xs text-muted-foreground">
                    Botões de atalho para consistência na comparação
                  </p>
                  <OptionsEditor
                    options={options}
                    onChange={setOptions}
                    onBeforeRemove={handleBeforeRemoveOption}
                  />
                </div>
              )}
            </div>
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
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Prompt de justificativa do LLM (opcional)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Em branco, usa o default que exige citação textual do trecho
                  do documento. <code>{"{name}"}</code> é a única chave
                  substituída (vira o nome do campo); qualquer outra chave entre
                  chaves faz o texto ser usado literalmente, sem substituição.
                </p>
                <Textarea
                  value={justificationPrompt}
                  onChange={(e) => setJustificationPrompt(e.target.value)}
                  placeholder="Ex.: Cite o trecho do parecer e explique como ele leva à resposta."
                  className="text-sm min-h-[60px] resize-y"
                />
              </div>
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
            {isSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

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
    </>
  );
}
