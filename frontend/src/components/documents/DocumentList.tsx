"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { Document } from "@/lib/types";

interface DocumentListProps {
  documents: (Document & { responseCount?: number })[];
  onSelect: (doc: Document) => void;
}

export function DocumentList({ documents, onSelect }: DocumentListProps) {
  const [search, setSearch] = useState("");

  const filtered = documents.filter(
    (d) =>
      (d.title?.toLowerCase().includes(search.toLowerCase()) ||
        d.external_id?.toLowerCase().includes(search.toLowerCase()) ||
        d.text.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div>
      <div className="mb-4 flex items-center gap-4">
        <Input
          placeholder="Buscar documentos..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <span className="text-sm text-muted-foreground">{filtered.length} docs</span>
      </div>
      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-2 text-left font-medium">ID</th>
              <th className="px-4 py-2 text-left font-medium">Título</th>
              <th className="px-4 py-2 text-left font-medium">Respostas</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((doc) => (
              <tr
                key={doc.id}
                className="cursor-pointer border-b transition-colors hover:bg-muted/30"
                onClick={() => onSelect(doc)}
              >
                <td className="px-4 py-2 font-mono text-xs">{doc.external_id || doc.id.slice(0, 8)}</td>
                <td className="px-4 py-2">{doc.title || "Sem título"}</td>
                <td className="px-4 py-2">
                  <Badge variant="secondary">{doc.responseCount || 0}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
