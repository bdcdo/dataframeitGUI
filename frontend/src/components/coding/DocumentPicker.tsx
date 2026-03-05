"use client";

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Shuffle, Check, Search } from "lucide-react";
import type { BrowseDocument } from "@/actions/documents";

interface DocumentPickerProps {
  documents: BrowseDocument[];
  onSelect: (docId: string) => void;
}

export function DocumentPicker({ documents, onSelect }: DocumentPickerProps) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return documents;
    const q = search.toLowerCase();
    return documents.filter(
      (d) =>
        d.title?.toLowerCase().includes(q) ||
        d.external_id?.toLowerCase().includes(q)
    );
  }, [documents, search]);

  const handleRandom = () => {
    const notResponded = documents.filter((d) => !d.userAlreadyResponded);
    const pool = notResponded.length > 0 ? notResponded : documents;
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    onSelect(pick.id);
  };

  if (documents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Nenhum documento no projeto.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por titulo ou ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={handleRandom}>
          <Shuffle className="mr-1.5 h-4 w-4" />
          Aleatorio
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Nenhum documento encontrado.
          </div>
        ) : (
          <div className="divide-y">
            {filtered.map((doc) => (
              <button
                key={doc.id}
                onClick={() => onSelect(doc.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {doc.title || doc.external_id || "Sem titulo"}
                  </p>
                  {doc.external_id && doc.title && (
                    <p className="truncate text-xs text-muted-foreground">
                      {doc.external_id}
                    </p>
                  )}
                </div>
                <Badge variant="secondary" className="shrink-0">
                  {doc.responseCount} {doc.responseCount === 1 ? "resposta" : "respostas"}
                </Badge>
                {doc.userAlreadyResponded && (
                  <Check className="h-4 w-4 shrink-0 text-brand" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
