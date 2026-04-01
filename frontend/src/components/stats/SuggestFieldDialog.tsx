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
import { Loader2 } from "lucide-react";
import { OptionsEditor } from "@/components/schema/OptionsEditor";
import { createSchemaSuggestion } from "@/actions/suggestions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import type { PydanticField } from "@/lib/types";

const TYPE_LABELS: Record<string, string> = {
  single: "Escolha única",
  multi: "Múltipla escolha",
  text: "Texto livre",
  date: "Data",
};

interface SuggestFieldDialogProps {
  projectId: string;
  fieldName: string;
  allFields: PydanticField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SuggestFieldDialog({
  projectId,
  fieldName,
  allFields,
  open,
  onOpenChange,
}: SuggestFieldDialogProps) {
  const router = useRouter();
  const field = allFields.find((f) => f.name === fieldName);
  const [description, setDescription] = useState(field?.description ?? "");
  const [helpText, setHelpText] = useState(field?.help_text ?? "");
  const [options, setOptions] = useState<string[]>(field?.options ?? []);
  const [reason, setReason] = useState("");
  const [isSaving, startSave] = useTransition();

  const [prevFieldName, setPrevFieldName] = useState(fieldName);
  if (fieldName !== prevFieldName) {
    setPrevFieldName(fieldName);
    const f = allFields.find((ff) => ff.name === fieldName);
    setDescription(f?.description ?? "");
    setHelpText(f?.help_text ?? "");
    setOptions(f?.options ?? []);
    setReason("");
  }

  if (!field) return null;

  const hasChanges =
    description !== field.description ||
    helpText !== (field.help_text || "") ||
    JSON.stringify(options) !== JSON.stringify(field.options || []);

  const handleSubmit = () => {
    if (!reason.trim()) {
      toast.error("Informe o motivo da sugestão");
      return;
    }
    if (!hasChanges) {
      toast.error("Nenhuma alteração sugerida");
      return;
    }

    const changes: Record<string, unknown> = {};
    if (description !== field.description) changes.description = description;
    if (helpText !== (field.help_text || "")) changes.help_text = helpText;
    if (JSON.stringify(options) !== JSON.stringify(field.options || [])) {
      changes.options = options.length > 0 ? options : null;
    }

    startSave(async () => {
      const result = await createSchemaSuggestion(
        projectId,
        fieldName,
        changes,
        reason.trim(),
      );
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Sugestão enviada ao coordenador");
        onOpenChange(false);
        router.refresh();
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Sugerir alteração
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
            <Label className="text-xs">Descrição</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="O que este campo representa?"
              className="text-sm h-8"
            />
            {description !== field.description && (
              <p className="text-xs text-muted-foreground">
                Atual: <span className="line-through">{field.description}</span>
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Instruções complementares</Label>
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
          {field.type === "text" && !field.subfields && (
            <div className="space-y-1.5">
              <Label className="text-xs">Respostas padronizadas</Label>
              <OptionsEditor options={options} onChange={setOptions} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs text-amber-600">
              Motivo da sugestão *
            </Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explique por que esta mudança é necessária..."
              className="text-sm min-h-[60px] resize-y border-amber-200"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button
            size="sm"
            disabled={isSaving || !hasChanges || !reason.trim()}
            onClick={handleSubmit}
          >
            {isSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Enviar sugestão
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
