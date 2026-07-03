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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import type { ExcludeTarget } from "./useDocumentActions";

// Dialog de exclusão reversível (soft delete) do DocumentsPageClient.
export function ExcludeDocumentsDialog({
  target,
  reason,
  onReasonChange,
  isPending,
  onConfirm,
  onClose,
}: {
  target: ExcludeTarget | null;
  reason: string;
  onReasonChange: (value: string) => void;
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
              ? "Excluir documento?"
              : `Excluir ${target?.ids.length} documentos?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target && target.totalResponses > 0 ? (
              <>
                {target.ids.length === 1
                  ? "Este documento"
                  : `Estes ${target.ids.length} documentos`}{" "}
                e suas <strong>{target.totalResponses} resposta(s)</strong>{" "}
                serão ocultados das listas. A exclusão é reversível:
                você pode restaurar ou apagar permanentemente depois em
                &quot;Mostrar excluídos&quot;.
              </>
            ) : (
              <>
                {target?.ids.length === 1
                  ? "O documento"
                  : `Os ${target?.ids.length} documentos`}{" "}
                serão ocultados das listas. A exclusão é reversível.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="exclude-reason">
            Motivo da exclusão <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="exclude-reason"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Ex: parecer fora do escopo do projeto"
            rows={3}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isPending || !reason.trim()}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Excluindo…
              </>
            ) : (
              "Excluir"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
