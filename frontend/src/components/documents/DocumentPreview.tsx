"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDocumentText } from "@/hooks/useDocumentText";

interface DocumentPreviewProps {
  documentId: string | null;
  title: string;
  open: boolean;
  onClose: () => void;
  /** projectId do documento — usado pelo fetch de texto via `getDocumentText`. */
  projectId: string;
}

export function DocumentPreview({
  documentId,
  title,
  open,
  onClose,
  projectId,
}: DocumentPreviewProps) {
  const { text, loading, error, retry } = useDocumentText(
    projectId,
    open ? documentId : null,
  );

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
        ) : error ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{text}</p>
            <Button variant="outline" size="sm" onClick={retry}>
              Tentar novamente
            </Button>
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
