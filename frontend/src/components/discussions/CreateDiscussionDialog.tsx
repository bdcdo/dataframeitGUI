"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { createDiscussion } from "@/actions/discussions";
import { toast } from "sonner";
import { ChevronsUpDown, Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface CreateDiscussionDialogProps {
  projectId: string;
  documents: { id: string; title: string | null; external_id: string | null }[];
  defaultDocumentId?: string;
  trigger?: React.ReactNode;
  onCreated?: (id: string) => void;
  externalOpen?: boolean;
  onExternalOpenChange?: (open: boolean) => void;
}

export function CreateDiscussionDialog({
  projectId,
  documents,
  defaultDocumentId,
  trigger,
  onCreated,
  externalOpen,
  onExternalOpenChange,
}: CreateDiscussionDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = externalOpen !== undefined;
  const open = isControlled ? externalOpen : internalOpen;
  const setOpen = isControlled ? (v: boolean) => onExternalOpenChange?.(v) : setInternalOpen;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [documentId, setDocumentId] = useState(defaultDocumentId ?? "");
  const [comboOpen, setComboOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (defaultDocumentId !== undefined) {
      setDocumentId(defaultDocumentId);
    }
  }, [defaultDocumentId]);

  const selectedDoc = documents.find((d) => d.id === documentId);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setLoading(true);
    const result = await createDiscussion(
      projectId,
      title.trim(),
      body.trim() || undefined,
      documentId || undefined
    );
    setLoading(false);

    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success("Discussão criada!");
      setTitle("");
      setBody("");
      setDocumentId("");
      setOpen(false);
      if (result.id) onCreated?.(result.id);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!isControlled && (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button className="bg-brand hover:bg-brand/90 text-brand-foreground">
              <Plus className="mr-2 h-4 w-4" />
              Nova Discussão
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova Discussão</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="disc-title">Título</Label>
            <Input
              id="disc-title"
              placeholder="Resumo da questão..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="disc-body">Descrição (opcional)</Label>
            <Textarea
              id="disc-body"
              placeholder="Detalhes, contexto..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
            />
          </div>

          <div className="space-y-2">
            <Label>Documento vinculado (opcional)</Label>
            <Popover open={comboOpen} onOpenChange={setComboOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={comboOpen}
                  className="w-full justify-between font-normal"
                >
                  {selectedDoc
                    ? selectedDoc.title || selectedDoc.external_id || "Documento"
                    : "Selecionar documento..."}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                <Command>
                  <CommandInput placeholder="Buscar documento..." />
                  <CommandList>
                    <CommandEmpty>Nenhum documento encontrado.</CommandEmpty>
                    <CommandGroup>
                      {documents.map((doc) => (
                        <CommandItem
                          key={doc.id}
                          value={`${doc.title ?? ""} ${doc.external_id ?? ""}`}
                          onSelect={() => {
                            setDocumentId(doc.id === documentId ? "" : doc.id);
                            setComboOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              documentId === doc.id
                                ? "opacity-100"
                                : "opacity-0"
                            )}
                          />
                          {doc.title || doc.external_id || "Sem título"}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <Button
            onClick={handleSubmit}
            disabled={loading || !title.trim()}
            className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
          >
            {loading ? "Criando..." : "Criar Discussão"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
