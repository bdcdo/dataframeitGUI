"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@clerk/nextjs";
import { createBrowserClient } from "@/lib/supabase/client";

interface DocumentPreviewProps {
  documentId: string | null;
  title: string;
  open: boolean;
  onClose: () => void;
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
  allowExcluded = false,
}: DocumentPreviewProps) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { getToken } = useAuth();

  useEffect(() => {
    if (!documentId || !open) {
      setText(null);
      return;
    }
    setLoading(true);
    getToken({ template: "supabase" })
      .then((token) => {
        const supabase = createBrowserClient(token);
        let query = supabase
          .from("documents")
          .select("text")
          .eq("id", documentId);
        if (!allowExcluded) {
          query = query.is("excluded_at", null);
        }
        return query.maybeSingle();
      })
      .then(({ data }) => {
        setText(data?.text ?? null);
      })
      .catch(() => {
        setText(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [documentId, open, getToken, allowExcluded]);

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
