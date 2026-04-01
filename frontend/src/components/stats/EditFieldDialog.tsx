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
import { saveSchemaFromGUI } from "@/actions/schema";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import type { PydanticField, SubfieldDef } from "@/lib/types";

const TYPE_LABELS: Record<string, string> = {
  single: "Escolha única",
  multi: "Múltipla escolha",
  text: "Texto livre",
  date: "Data",
};

interface EditFieldDialogProps {
  projectId: string;
  fieldName: string;
  allFields: PydanticField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditFieldDialog({
  projectId,
  fieldName,
  allFields,
  open,
  onOpenChange,
}: EditFieldDialogProps) {
  const router = useRouter();
  const field = allFields.find((f) => f.name === fieldName);
  const [description, setDescription] = useState(field?.description ?? "");
  const [helpText, setHelpText] = useState(field?.help_text ?? "");
  const [options, setOptions] = useState<string[]>(field?.options ?? []);
  const [subfields, setSubfields] = useState<SubfieldDef[] | undefined>(field?.subfields);
  const [subfieldRule, setSubfieldRule] = useState<"all" | "at_least_one">(field?.subfield_rule ?? "all");
  const [isSaving, startSave] = useTransition();

  // Reset state when dialog opens with a different field
  const [prevFieldName, setPrevFieldName] = useState(fieldName);
  if (fieldName !== prevFieldName) {
    setPrevFieldName(fieldName);
    const f = allFields.find((ff) => ff.name === fieldName);
    setDescription(f?.description ?? "");
    setHelpText(f?.help_text ?? "");
    setOptions(f?.options ?? []);
    setSubfields(f?.subfields);
    setSubfieldRule(f?.subfield_rule ?? "all");
  }

  if (!field) return null;

  const descriptionChanged = description !== field.description;
  const hasSubfields = subfields && subfields.length > 0;

  const handleSave = () => {
    startSave(async () => {
      const updatedFields = allFields.map((f) =>
        f.name === fieldName
          ? {
              ...f,
              description,
              help_text: helpText.trim() || undefined,
              options: hasSubfields ? null : (options.length > 0 ? options : null),
              subfields: hasSubfields ? subfields : undefined,
              subfield_rule: hasSubfields ? subfieldRule : undefined,
            }
          : f,
      );
      try {
        await saveSchemaFromGUI(projectId, updatedFields);
        toast.success("Campo atualizado");
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Editar campo
            <code className="text-sm font-mono text-muted-foreground">
              {fieldName}
            </code>
          </DialogTitle>
        </DialogHeader>

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
            <div className="space-y-1.5">
              <Label className="text-xs">Opções</Label>
              <OptionsEditor options={options} onChange={setOptions} />
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
                  <OptionsEditor options={options} onChange={setOptions} />
                </div>
              )}
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
  );
}
