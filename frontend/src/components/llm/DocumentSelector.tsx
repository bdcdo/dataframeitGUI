"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getDocumentsForSelection, type DocSelectionItem } from "@/actions/llm";
import { FileText, User, Bot } from "lucide-react";

interface DocumentSelectorProps {
  projectId: string;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

export function DocumentSelector({
  projectId,
  selectedIds,
  onSelectionChange,
}: DocumentSelectorProps) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<DocSelectionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [localSelected, setLocalSelected] = useState<Set<string>>(
    new Set(selectedIds)
  );

  useEffect(() => {
    if (open) {
      setLoading(true);
      setLocalSelected(new Set(selectedIds));
      getDocumentsForSelection(projectId)
        .then((data) => setDocs(data))
        .catch(() => setDocs([]))
        .finally(() => setLoading(false));
    }
  }, [open, projectId, selectedIds]);

  const filtered = useMemo(() => {
    if (!search.trim()) return docs;
    const q = search.toLowerCase();
    return docs.filter(
      (d) =>
        d.title?.toLowerCase().includes(q) ||
        d.external_id?.toLowerCase().includes(q)
    );
  }, [docs, search]);

  const toggle = (id: string) => {
    setLocalSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setLocalSelected(new Set(filtered.map((d) => d.id)));
  const clearAll = () => setLocalSelected(new Set());

  const selectWithHuman = () => {
    setLocalSelected(
      new Set(filtered.filter((d) => d.hasHumanResponse).map((d) => d.id))
    );
  };

  const selectWithoutLlm = () => {
    setLocalSelected(
      new Set(filtered.filter((d) => d.llmResponseCount === 0).map((d) => d.id))
    );
  };

  const handleConfirm = () => {
    onSelectionChange(Array.from(localSelected));
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {selectedIds.length > 0
            ? `${selectedIds.length} documento${selectedIds.length !== 1 ? "s" : ""} selecionado${selectedIds.length !== 1 ? "s" : ""}`
            : "Selecionar documentos"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Selecionar documentos</DialogTitle>
          <DialogDescription>
            Escolha os documentos para processar com o LLM.
          </DialogDescription>
        </DialogHeader>

        <Input
          placeholder="Buscar por título ou ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-sm"
        />

        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={selectAll}>
            Todos
          </Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={clearAll}>
            Limpar
          </Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={selectWithHuman}>
            Com resposta humana
          </Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={selectWithoutLlm}>
            Sem resposta LLM
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto border rounded-md divide-y">
          {loading && (
            <p className="p-4 text-sm text-muted-foreground text-center">
              Carregando...
            </p>
          )}
          {!loading && filtered.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground text-center">
              Nenhum documento encontrado.
            </p>
          )}
          {filtered.map((doc) => (
            <label
              key={doc.id}
              className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer text-sm"
            >
              <Checkbox
                checked={localSelected.has(doc.id)}
                onCheckedChange={() => toggle(doc.id)}
              />
              <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="truncate flex-1">
                {doc.title || doc.external_id || doc.id.slice(0, 8)}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                {doc.hasHumanResponse && (
                  <Badge variant="secondary" className="text-[10px] h-5 gap-0.5">
                    <User className="h-2.5 w-2.5" />
                  </Badge>
                )}
                {doc.llmResponseCount > 0 && (
                  <Badge variant="secondary" className="text-[10px] h-5 gap-0.5">
                    <Bot className="h-2.5 w-2.5" />
                    {doc.llmResponseCount}
                  </Badge>
                )}
              </div>
            </label>
          ))}
        </div>

        <DialogFooter>
          <p className="flex-1 text-xs text-muted-foreground">
            {localSelected.size} selecionado{localSelected.size !== 1 ? "s" : ""}
          </p>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button
            onClick={handleConfirm}
            className="bg-brand hover:bg-brand/90 text-brand-foreground"
            disabled={localSelected.size === 0}
          >
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
