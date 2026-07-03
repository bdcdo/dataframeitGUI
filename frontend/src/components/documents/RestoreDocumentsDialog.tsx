"use client";

import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import type { RestoreTarget } from "./useDocumentActions";

// Dialog de restauração de documentos excluídos do DocumentsPageClient.
export function RestoreDocumentsDialog({
  target,
  isPending,
  onConfirm,
  onClose,
}: {
  target: RestoreTarget | null;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmActionDialog
      open={!!target}
      onClose={onClose}
      title={
        target?.ids.length === 1
          ? "Restaurar documento?"
          : `Restaurar ${target?.ids.length} documentos?`
      }
      description={
        target?.ids.length === 1
          ? "O documento voltará à lista ativa do projeto."
          : `Os ${target?.ids.length} documentos voltarão à lista ativa do projeto.`
      }
      confirmLabel="Restaurar"
      pendingLabel="Restaurando…"
      isPending={isPending}
      onConfirm={onConfirm}
    />
  );
}
