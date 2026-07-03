"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2 } from "lucide-react";
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
    <AlertDialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {target?.ids.length === 1
              ? "Restaurar documento?"
              : `Restaurar ${target?.ids.length} documentos?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target?.ids.length === 1
              ? "O documento voltará à lista ativa do projeto."
              : `Os ${target?.ids.length} documentos voltarão à lista ativa do projeto.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Restaurando…
              </>
            ) : (
              "Restaurar"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
