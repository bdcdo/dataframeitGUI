"use client";

import type { ReactNode } from "react";
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
import { cn } from "@/lib/utils";

// Esqueleto compartilhado dos AlertDialogs de confirmação (título, descrição,
// footer Cancelar/Ação com troca de texto + spinner enquanto isPending).
// `children` é o slot para conteúdo extra entre a descrição e o footer (ex:
// o textarea de motivo do ExcludeDocumentsDialog).
export function ConfirmActionDialog({
  open,
  onClose,
  title,
  description,
  children,
  confirmLabel,
  pendingLabel,
  destructive = false,
  isPending,
  disabled = false,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  isPending: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {children}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            // AlertDialogAction fecha o diálogo por padrão. Quem confirma é que
            // decide se o fluxo terminou: sem o preventDefault o diálogo sai de
            // cena antes de `isPending` renderizar, e uma confirmação recusada
            // (ExcludeDocumentsDialog sem motivo) descartaria o que já foi
            // digitado em vez de deixar o usuário corrigir.
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            disabled={isPending || disabled}
            className={cn(
              destructive &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {isPending ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                {pendingLabel}
              </>
            ) : (
              confirmLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
