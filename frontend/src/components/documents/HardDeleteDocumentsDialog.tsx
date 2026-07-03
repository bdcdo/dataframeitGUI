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
              ? "Apagar permanentemente?"
              : `Apagar ${target?.ids.length} documentos permanentemente?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <strong>Esta ação não pode ser desfeita.</strong> O documento e
            todas as respostas, revisões e atribuições associadas serão
            removidos do banco de dados.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Apagando…
              </>
            ) : (
              "Apagar definitivamente"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
