"use client";

import { useState, useDeferredValue } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyLinkButton } from "@/components/ui/CopyLinkButton";
import { Trash2, RotateCcw } from "lucide-react";
import type { Document } from "@/lib/types";
import { formatDate } from "@/lib/date-format";

// `excluded_at` so existe em documento excluido; o traco e a convencao de
// campo vazio da tabela. Mantido aqui, e nao no helper, porque e decisao de
// apresentacao desta lista — o helper so formata.
function formatExcludedAt(iso: string | null | undefined): string {
  return iso ? formatDate(iso) : "—";
}

export type DocumentSummary = Pick<Document, "id" | "external_id" | "title"> & {
  responseCount?: number;
  excluded_at?: string | null;
  excluded_reason?: string | null;
  excluded_by_name?: string | null;
  /** Pedido de exclusão pendente (revisão de escopo) — doc ainda ativo mas
   *  já escondido das filas de codificação/Comparação/LLM para todos. */
  exclusion_pending_at?: string | null;
};

// Handler puro: Enter/espaço ativam um elemento que só respondia a clique.
// Depende apenas dos argumentos (sem closure sobre props/state), então vive no
// escopo do módulo em vez de ser reconstruído a cada linha renderizada.
function activateOnKeyboard(
  e: React.KeyboardEvent<HTMLElement>,
  activate: () => void,
) {
  if (e.key !== "Enter" && e.key !== " ") return;
  // Só quando o foco está no próprio elemento: Enter/espaço em um controle
  // interno (checkbox, copiar link, excluir) pertence a ele.
  if (e.target !== e.currentTarget) return;
  e.preventDefault();
  activate();
}

/**
 * Quais colunas opcionais a tabela mostra. Viaja como objeto único porque são
 * as mesmas decisões no cabeçalho e em cada linha — separá-las em booleanos
 * soltos multiplicaria a chance de as duas metades divergirem.
 */
interface ColumnFlags {
  select: boolean;
  copyLink: boolean;
  delete: boolean;
  restore: boolean;
  hardDelete: boolean;
  excludedDetails: boolean;
}

/** Célula de ação com ícone: para o clique antes que ele abra o documento. */
function ActionCell({
  title,
  onClick,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
      <Button
        variant="ghost"
        size="icon"
        className={`size-7 ${className ?? ""}`}
        onClick={onClick}
        title={title}
      >
        {children}
      </Button>
    </td>
  );
}

function DocumentTableHead({
  columns,
  allSelected,
  someSelected,
  onToggleAll,
}: {
  columns: ColumnFlags;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll?: (checked: boolean) => void;
}) {
  return (
    <thead>
      <tr className="border-b bg-muted/50">
        {columns.select && (
          <th className="w-10 px-4 py-2">
            <Checkbox
              aria-label="Selecionar todos os documentos filtrados"
              checked={
                allSelected ? true : someSelected ? "indeterminate" : false
              }
              onCheckedChange={(checked) => onToggleAll?.(!!checked)}
            />
          </th>
        )}
        <th className="px-4 py-2 text-left font-medium">ID</th>
        <th className="px-4 py-2 text-left font-medium">Título</th>
        {columns.excludedDetails ? (
          <>
            <th className="px-4 py-2 text-left font-medium">Excluído em</th>
            <th className="px-4 py-2 text-left font-medium">Por</th>
            <th className="px-4 py-2 text-left font-medium">Motivo</th>
          </>
        ) : (
          <th className="px-4 py-2 text-left font-medium">Respostas</th>
        )}
        {columns.copyLink && (
          <th className="w-10 px-4 py-2">
            <span className="sr-only">Copiar link</span>
          </th>
        )}
        {columns.delete && (
          <th className="w-10 px-4 py-2">
            <span className="sr-only">Excluir</span>
          </th>
        )}
        {columns.restore && (
          <th className="w-10 px-4 py-2">
            <span className="sr-only">Restaurar</span>
          </th>
        )}
        {columns.hardDelete && (
          <th className="w-10 px-4 py-2">
            <span className="sr-only">Apagar permanentemente</span>
          </th>
        )}
      </tr>
    </thead>
  );
}

/** Colunas do meio: detalhes da exclusão ou a contagem de respostas. */
function DetailCells({
  doc,
  excluded,
}: {
  doc: DocumentSummary;
  excluded: boolean;
}) {
  if (excluded) {
    return (
      <>
        <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
          {formatExcludedAt(doc.excluded_at)}
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
    );
  }
  return (
    <td className="px-4 py-2">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{doc.responseCount || 0}</Badge>
        {doc.exclusion_pending_at && (
          <Badge
            variant="outline"
            className="border-amber-500/40 text-amber-600 dark:text-amber-400"
            title="Sinalizado como fora do escopo — aguardando decisão do coordenador em Comentários"
          >
            Revisão de escopo pendente
          </Badge>
        )}
      </div>
    </td>
  );
}

/** Colunas de ação à direita. Quais aparecem depende do modo da lista. */
function RowActions({
  doc,
  columns,
  onRequestDelete,
  onRequestRestore,
  onRequestHardDelete,
}: {
  doc: DocumentSummary;
  columns: ColumnFlags;
  onRequestDelete?: (doc: DocumentSummary) => void;
  onRequestRestore?: (doc: DocumentSummary) => void;
  onRequestHardDelete?: (doc: DocumentSummary) => void;
}) {
  return (
    <>
      {columns.delete && (
        <ActionCell
          title="Excluir"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => onRequestDelete?.(doc)}
        >
          <Trash2 className="size-3.5" />
        </ActionCell>
      )}
      {columns.restore && (
        <ActionCell
          title="Restaurar"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onRequestRestore?.(doc)}
        >
          <RotateCcw className="size-3.5" />
        </ActionCell>
      )}
      {columns.hardDelete && (
        <ActionCell
          title="Apagar permanentemente"
          className="text-destructive hover:bg-destructive/10"
          onClick={() => onRequestHardDelete?.(doc)}
        >
          <Trash2 className="size-3.5" />
        </ActionCell>
      )}
    </>
  );
}

function DocumentRow({
  doc,
  columns,
  projectId,
  selected,
  onSelect,
  onToggleSelect,
  onRequestDelete,
  onRequestRestore,
  onRequestHardDelete,
}: {
  doc: DocumentSummary;
  columns: ColumnFlags;
  projectId?: string;
  selected: boolean;
  onSelect: (doc: DocumentSummary) => void;
  onToggleSelect?: (docId: string) => void;
  onRequestDelete?: (doc: DocumentSummary) => void;
  onRequestRestore?: (doc: DocumentSummary) => void;
  onRequestHardDelete?: (doc: DocumentSummary) => void;
}) {
  return (
    <tr
      className="cursor-pointer border-b transition-colors hover:bg-muted/30 focus-visible:bg-muted/50 focus-visible:outline-none"
      // A linha inteira é o alvo de clique; sem foco e sem teclado, abrir um
      // documento era exclusivo do mouse.
      tabIndex={0}
      onClick={() => onSelect(doc)}
      onKeyDown={(e) => activateOnKeyboard(e, () => onSelect(doc))}
    >
      {columns.select && (
        <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            aria-label={`Selecionar ${doc.title || doc.external_id || "documento"}`}
            checked={selected}
            onCheckedChange={() => onToggleSelect?.(doc.id)}
          />
        </td>
      )}
      <td className="px-4 py-2 font-mono text-xs">
        {doc.external_id || doc.id.slice(0, 8)}
      </td>
      <td className="px-4 py-2">{doc.title || "Sem título"}</td>
      <DetailCells doc={doc} excluded={columns.excludedDetails} />
      {columns.copyLink && (
        <td className="px-4 py-2">
          <CopyLinkButton
            url={`/projects/${projectId}/analyze/code?doc=${doc.id}`}
          />
        </td>
      )}
      <RowActions
        doc={doc}
        columns={columns}
        onRequestDelete={onRequestDelete}
        onRequestRestore={onRequestRestore}
        onRequestHardDelete={onRequestHardDelete}
      />
    </tr>
  );
}

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

  const columns: ColumnFlags = {
    select: !!onToggleSelect,
    copyLink: !!projectId && !showExcluded,
    delete: !!onRequestDelete && !showExcluded,
    restore: !!onRequestRestore && showExcluded,
    hardDelete: !!onRequestHardDelete && showExcluded,
    excludedDetails: showExcluded,
  };

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
          <DocumentTableHead
            columns={columns}
            allSelected={allFilteredSelected}
            someSelected={someFilteredSelected}
            onToggleAll={onToggleAll}
          />
          <tbody>
            {filtered.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                columns={columns}
                projectId={projectId}
                selected={selectedIds?.has(doc.id) ?? false}
                onSelect={onSelect}
                onToggleSelect={onToggleSelect}
                onRequestDelete={onRequestDelete}
                onRequestRestore={onRequestRestore}
                onRequestHardDelete={onRequestHardDelete}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
