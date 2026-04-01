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
import { AlertTriangle, Loader2 } from "lucide-react";
import { OptionsEditor } from "@/components/schema/OptionsEditor";
import { saveSchemaFromGUI } from "@/actions/schema";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import type { PydanticField } from "@/lib/types";

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
  commentCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditFieldDialog({
  projectId,
  fieldName,
  allFields,
  commentCount,
  open,
  onOpenChange,
}: EditFieldDialogProps) {
  const router = useRouter();
  const field = allFields.find((f) => f.name === fieldName);
  const [description, setDescription] = useState(field?.description ?? "");
  const [helpText, setHelpText] = useState(field?.help_text ?? "");
  const [options, setOptions] = useState<string[]>(field?.options ?? []);
  const [isSaving, startSave] = useTransition();

  // Reset state when dialog opens with a different field
  const [prevFieldName, setPrevFieldName] = useState(fieldName);
  if (fieldName !== prevFieldName) {
    setPrevFieldName(fieldName);
    const f = allFields.find((ff) => ff.name === fieldName);
    setDescription(f?.description ?? "");
    setHelpText(f?.help_text ?? "");
    setOptions(f?.options ?? []);
  }

  if (!field) return null;

  const descriptionChanged = description !== field.description;

  const handleSave = () => {
    startSave(async () => {
      const updatedFields = allFields.map((f) =>
        f.name === fieldName
          ? {
              ...f,
              description,
              help_text: helpText.trim() || undefined,
              options: options.length > 0 ? options : null,
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
          {commentCount > 1 && (
            <p className="text-xs text-muted-foreground">
              {commentCount} comentários neste campo
            </p>
          )}

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
            <div className="space-y-1.5">
              <Label className="text-xs">Respostas padronizadas</Label>
              <p className="text-xs text-muted-foreground">
                Botões de atalho para consistência na comparação
              </p>
              <OptionsEditor options={options} onChange={setOptions} />
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
