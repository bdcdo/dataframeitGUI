"use client";

import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import type { HardDeleteTarget } from "./useDocumentActions";

// Dialog de apagamento permanente (irreversível) do DocumentsPageClient.
export function HardDeleteDocumentsDialog({
  target,
  isPending,
  onConfirm,
  onClose,
}: {
  target: HardDeleteTarget | null;
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
          ? "Apagar permanentemente?"
          : `Apagar ${target?.ids.length} documentos permanentemente?`
      }
      description={
        <>
          <strong>Esta ação não pode ser desfeita.</strong> O documento e
          todas as respostas, revisões e atribuições associadas serão
          removidos do banco de dados.
        </>
      }
      confirmLabel="Apagar definitivamente"
      pendingLabel="Apagando…"
      destructive
      isPending={isPending}
      onConfirm={onConfirm}
    />
  );
}
