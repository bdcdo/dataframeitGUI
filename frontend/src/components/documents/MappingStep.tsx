"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { CsvPreviewTable } from "./CsvPreviewTable";
import type { ColumnMapping } from "@/hooks/useDocumentUpload";

interface MappingStepProps {
  rows: Record<string, string>[];
  columns: string[];
  mapping: ColumnMapping;
  onMappingChange: (mapping: ColumnMapping) => void;
  disabled: boolean;
  onSubmit: () => void;
}

export function MappingStep({
  rows,
  columns,
  mapping,
  onMappingChange,
  disabled,
  onSubmit,
}: MappingStepProps) {
  const textColumnId = useId();
  const titleColumnId = useId();
  const externalIdColumnId = useId();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label htmlFor={textColumnId} className="text-sm font-medium">Coluna de texto *</label>
          <p className="text-xs text-muted-foreground">Conteúdo principal do documento que será analisado pelos pesquisadores</p>
          <select
            id={textColumnId}
            value={mapping.text}
            onChange={(e) => onMappingChange({ ...mapping, text: e.target.value })}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Selecione…</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={titleColumnId} className="text-sm font-medium">Coluna de título</label>
          <p className="text-xs text-muted-foreground">Nome curto para identificar o documento na interface (opcional)</p>
          <select
            id={titleColumnId}
            value={mapping.title}
            onChange={(e) => onMappingChange({ ...mapping, title: e.target.value })}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Nenhuma</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={externalIdColumnId} className="text-sm font-medium">Coluna de ID externo</label>
          <p className="text-xs text-muted-foreground">Identificador do dataset original, ex: número do processo, DOI (opcional)</p>
          <select
            id={externalIdColumnId}
            value={mapping.external_id}
            onChange={(e) => onMappingChange({ ...mapping, external_id: e.target.value })}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">Nenhuma</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <CsvPreviewTable rows={rows} columns={columns} />
      <Button
        onClick={onSubmit}
        disabled={disabled}
        className="bg-brand hover:bg-brand/90 text-brand-foreground"
      >
        Importar
      </Button>
    </div>
  );
}
