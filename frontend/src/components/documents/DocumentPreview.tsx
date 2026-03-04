"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Document } from "@/lib/types";

interface DocumentPreviewProps {
  document: Document | null;
  open: boolean;
  onClose: () => void;
}

export function DocumentPreview({ document, open, onClose }: DocumentPreviewProps) {
  if (!document) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{document.title || document.external_id || "Documento"}</DialogTitle>
        </DialogHeader>
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {document.text}
        </div>
      </DialogContent>
    </Dialog>
  );
}
