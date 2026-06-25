"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDocumentText } from "@/hooks/useDocumentText";

interface DocumentPreviewProps {
  documentId: string | null;
  title: string;
  open: boolean;
  onClose: () => void;
  /**
   * projectId do documento — usado pelo fetch de texto via `getDocumentText`.
   * Sempre presente no caller real (DocumentsPageClient, rota projects/[id]).
   */
  projectId?: string;
  /**
   * Por padrao, preview nao carrega texto de doc soft-deleted — alinhado com
   * o resto da UI que esconde excluidos. Setar true quando o caller estiver
   * no modo "Mostrar excluidos" para permitir visualizacao do historico.
   */
  allowExcluded?: boolean;
}

export function DocumentPreview({
  documentId,
  title,
  open,
  onClose,
  projectId,
  allowExcluded = false,
}: DocumentPreviewProps) {
  const { text, loading } = useDocumentText(projectId, open ? documentId : null, {
    allowExcluded,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="space-y-2">
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {text}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
