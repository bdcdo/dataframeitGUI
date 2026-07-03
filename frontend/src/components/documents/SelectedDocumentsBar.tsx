"use client";

import { Button } from "@/components/ui/button";
import { Trash2, RotateCcw } from "lucide-react";

// Barra de ações em lote do DocumentsPageClient. A união discriminada
// substitui os 2 booleanos (showExcluded + qual botão mostrar) por um único
// campo que torna "ação inválida para o modo atual" irrepresentável.
export function SelectedDocumentsBar({
  count,
  actions,
}: {
  count: number;
  actions:
    | { kind: "active"; onExclude: () => void }
    | { kind: "excluded"; onRestore: () => void; onHardDelete: () => void };
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-2">
      <span className="text-sm font-medium">{count} selecionado(s)</span>
      {actions.kind === "excluded" ? (
        <>
          <Button variant="outline" size="sm" onClick={actions.onRestore}>
            <RotateCcw className="mr-1.5 size-3.5" />
            Restaurar selecionados
          </Button>
          <Button variant="destructive" size="sm" onClick={actions.onHardDelete}>
            <Trash2 className="mr-1.5 size-3.5" />
            Apagar permanentemente
          </Button>
        </>
      ) : (
        <Button variant="destructive" size="sm" onClick={actions.onExclude}>
          <Trash2 className="mr-1.5 size-3.5" />
          Excluir selecionados
        </Button>
      )}
    </div>
  );
}
