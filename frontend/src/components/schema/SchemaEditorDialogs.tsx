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

interface SchemaEditorDialogsProps {
  backfillOpen: boolean;
  onBackfillOpenChange: (open: boolean) => void;
  onConfirmBackfill: () => void;
  majorOpen: boolean;
  onMajorOpenChange: (open: boolean) => void;
  onConfirmPublishMajor: () => void;
  isPending: boolean;
  currentVersion: string;
}

/** Dialogs de confirmação do editor de schema: backfill de histórico e MAJOR. */
export function SchemaEditorDialogs({
  backfillOpen,
  onBackfillOpenChange,
  onConfirmBackfill,
  majorOpen,
  onMajorOpenChange,
  onConfirmPublishMajor,
  isPending,
  currentVersion,
}: SchemaEditorDialogsProps) {
  return (
    <>
      <AlertDialog open={backfillOpen} onOpenChange={onBackfillOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reconstruir versão pelo histórico?</AlertDialogTitle>
            <AlertDialogDescription>
              Percorre o histórico de mudanças em ordem cronológica, classifica cada
              entrada (MINOR em mudanças estruturais; PATCH em texto; MAJOR preservado)
              e reconstrói o schema em cada versão. Para atribuir versão a cada resposta,
              tenta match por <strong>answer_field_hashes</strong> (hashes gravados a cada
              save); se não bater, cai em <strong>created_at</strong>. Respostas salvas
              diretamente na plataforma (live_save) preservam a versão original.
              Idempotente: pode rodar de novo sem problemas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmBackfill} disabled={isPending}>
              Reconstruir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={majorOpen} onOpenChange={onMajorOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publicar nova versão MAJOR?</AlertDialogTitle>
            <AlertDialogDescription>
              Isso bumpa a versão do projeto de <strong>{currentVersion}</strong> para uma nova MAJOR
              (próximo inteiro). Use quando o codebook estiver estável e você quiser declarar uma
              baseline oficial. A partir daí, o filtro padrão da aba Comparar ignorará respostas
              de versões anteriores. Respostas antigas continuam salvas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmPublishMajor} disabled={isPending}>
              Publicar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
