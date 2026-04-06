"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  fieldName?: string | null;
  fields?: PydanticField[];
  variant?: "default" | "ghost" | "outline";
  size?: "default" | "sm" | "icon";
  label?: string;
}

export function AddNoteButton({
  projectId,
  documentId,
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={variant} size={size} className="gap-1.5 text-xs">
          <MessageSquarePlus className="h-3.5 w-3.5" />
          {label ?? "Nota"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="end">
        <p className="text-xs font-medium">Adicionar nota</p>
        {showFieldSelect && (
          <Select value={selectedField} onValueChange={setSelectedField}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Campo (opcional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">Geral (sem campo)</SelectItem>
              {fields.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.description || f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Escreva sua nota..."
          className="min-h-20 text-sm"
          autoFocus
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={isPending || !body.trim()}
            onClick={handleSubmit}
          >
            {isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : null}
            Salvar
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
