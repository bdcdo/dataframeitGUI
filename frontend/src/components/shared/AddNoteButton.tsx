"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquarePlus, Loader2 } from "lucide-react";
import { createProjectComment } from "@/actions/project-comments";
import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

interface AddNoteButtonProps {
  projectId: string;
  documentId?: string | null;
  documentTitle?: string | null;
  fieldName?: string | null;
  fields?: PydanticField[];
  variant?: "default" | "ghost" | "outline";
  size?: "default" | "sm" | "icon";
  label?: string;
}

export function AddNoteButton({
  projectId,
  documentId,
  documentTitle,
  fieldName: fixedFieldName,
  fields,
  variant = "ghost",
  size = "sm",
  label,
}: AddNoteButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [selectedField, setSelectedField] = useState<string>(fixedFieldName || "_none");
  const [isPending, startTransition] = useTransition();

  const showFieldSelect = !fixedFieldName && fields && fields.length > 0;

  // Build contextual subtitle
  const contextParts: string[] = [];
  if (documentTitle) contextParts.push(documentTitle);
  if (fixedFieldName) contextParts.push(fixedFieldName);
  const contextLabel = contextParts.length > 0 ? contextParts.join(" → ") : null;

  const handleSubmit = () => {
    if (!body.trim()) return;
    startTransition(async () => {
      const fieldValue = selectedField === "_none" ? null : selectedField;
      const result = await createProjectComment(
        projectId,
        body,
        documentId,
        fieldValue,
      );
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Nota adicionada");
        setBody("");
        setSelectedField(fixedFieldName || "_none");
        setOpen(false);
        router.refresh();
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size} className="gap-1.5 text-xs">
          <MessageSquarePlus className="h-3.5 w-3.5" />
          {label ?? "Nota"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">Adicionar nota</DialogTitle>
          {contextLabel && (
            <DialogDescription className="text-xs truncate">
              {contextLabel}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-3">
          {showFieldSelect && (
            <Select value={selectedField} onValueChange={setSelectedField}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Campo (opcional)" />
              </SelectTrigger>
              <SelectContent className="max-w-[calc(100vw-3rem)]">
                <SelectItem value="_none">Geral (sem campo específico)</SelectItem>
                {fields.map((f) => (
                  <SelectItem key={f.name} value={f.name}>
                    <div className="flex flex-col items-start gap-0.5">
                      <code className="text-xs font-mono">{f.name}</code>
                      {f.description && f.description !== f.name && (
                        <span className="text-[11px] text-muted-foreground line-clamp-2">
                          {f.description}
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Escreva sua nota..."
            className="min-h-28 text-sm"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancelar
            </Button>
            <Button
              size="sm"
              disabled={isPending || !body.trim()}
              onClick={handleSubmit}
            >
              {isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Salvar nota
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
