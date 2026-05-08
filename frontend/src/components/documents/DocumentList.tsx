"use client";

import { useState, useDeferredValue } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyLinkButton } from "@/components/ui/CopyLinkButton";
import { Trash2, RotateCcw, FlameKindling } from "lucide-react";
import type { Document } from "@/lib/types";

export type DocumentSummary = Pick<Document, "id" | "external_id" | "title"> & {
  responseCount?: number;
  excluded_at?: string | null;
  excluded_reason?: string | null;
  excluded_by_name?: string | null;
};

interface DocumentListProps {
  documents: DocumentSummary[];
  onSelect: (doc: DocumentSummary) => void;
  projectId?: string;
  selectedIds?: Set<string>;
  onToggleSelect?: (docId: string) => void;
  onToggleAll?: (checked: boolean) => void;
  onRequestDelete?: (doc: DocumentSummary) => void;
  onRequestRestore?: (doc: DocumentSummary) => void;
  onRequestHardDelete?: (doc: DocumentSummary) => void;
  /** quando true, lista mostra apenas excluidos e troca acoes (restaurar / apagar permanente) */
  showExcluded?: boolean;
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function DocumentList({
  documents,
  onSelect,
  projectId,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  onRequestDelete,
  onRequestRestore,
  onRequestHardDelete,
  showExcluded = false,
}: DocumentListProps) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  const filtered = documents.filter(
    (d) =>
      d.title?.toLowerCase().includes(deferredSearch.toLowerCase()) ||
      d.external_id?.toLowerCase().includes(deferredSearch.toLowerCase()),
  );

  const canSelect = !!onToggleSelect;
  const canDelete = !!onRequestDelete && !showExcluded;
  const canRestore = !!onRequestRestore && showExcluded;
  const canHardDelete = !!onRequestHardDelete && showExcluded;

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((d) => selectedIds?.has(d.id));
  const someFilteredSelected = filtered.some((d) => selectedIds?.has(d.id));

  return (
    <div>
      <div className="mb-4 flex items-center gap-4">
        <Input
          placeholder="Buscar documentos..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <span className="text-sm text-muted-foreground">
          {filtered.length} {showExcluded ? "excluídos" : "docs"}
        </span>
      </div>
      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {canSelect && (
                <th className="w-10 px-4 py-2">
                  <Checkbox
                    checked={
                      allFilteredSelected
                        ? true
                        : someFilteredSelected
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(checked) => onToggleAll?.(!!checked)}
                  />
                </th>
              )}
              <th className="px-4 py-2 text-left font-medium">ID</th>
              <th className="px-4 py-2 text-left font-medium">Título</th>
              {showExcluded ? (
                <>
                  <th className="px-4 py-2 text-left font-medium">
                    Excluído em
                  </th>
                  <th className="px-4 py-2 text-left font-medium">Por</th>
                  <th className="px-4 py-2 text-left font-medium">Motivo</th>
                </>
              ) : (
                <th className="px-4 py-2 text-left font-medium">Respostas</th>
              )}
              {projectId && !showExcluded && (
                <th className="w-10 px-4 py-2"></th>
              )}
              {canDelete && <th className="w-10 px-4 py-2"></th>}
              {canRestore && <th className="w-10 px-4 py-2"></th>}
              {canHardDelete && <th className="w-10 px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((doc) => (
              <tr
                key={doc.id}
                className="cursor-pointer border-b transition-colors hover:bg-muted/30"
                onClick={() => onSelect(doc)}
              >
                {canSelect && (
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds?.has(doc.id) ?? false}
                      onCheckedChange={() => onToggleSelect?.(doc.id)}
                    />
                  </td>
                )}
                <td className="px-4 py-2 font-mono text-xs">
                  {doc.external_id || doc.id.slice(0, 8)}
                </td>
                <td className="px-4 py-2">{doc.title || "Sem título"}</td>
                {showExcluded ? (
                  <>
                    <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                      {formatDate(doc.excluded_at)}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {doc.excluded_by_name || "—"}
                    </td>
                    <td
                      className="max-w-xs truncate px-4 py-2 text-muted-foreground"
                      title={doc.excluded_reason || ""}
                    >
                      {doc.excluded_reason || "—"}
                    </td>
                  </>
                ) : (
                  <td className="px-4 py-2">
                    <Badge variant="secondary">{doc.responseCount || 0}</Badge>
                  </td>
                )}
                {projectId && !showExcluded && (
                  <td className="px-4 py-2">
                    <CopyLinkButton
                      url={`${typeof window !== "undefined" ? window.location.origin : ""}/projects/${projectId}/analyze/code?doc=${doc.id}`}
                    />
                  </td>
                )}
                {canDelete && (
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => onRequestDelete?.(doc)}
                      title="Excluir"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                )}
                {canRestore && (
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => onRequestRestore?.(doc)}
                      title="Restaurar"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                )}
                {canHardDelete && (
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => onRequestHardDelete?.(doc)}
                      title="Apagar permanentemente"
                    >
                      <FlameKindling className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
