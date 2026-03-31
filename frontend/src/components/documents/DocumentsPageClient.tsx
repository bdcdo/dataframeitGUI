"use client";

import { useState, useTransition } from "react";
import { DocumentList, type DocumentSummary } from "@/components/documents/DocumentList";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import { deleteDocuments } from "@/actions/documents";
import { Button } from "@/components/ui/button";
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
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Document } from "@/lib/types";

type DocSummary = Pick<Document, "id" | "external_id" | "title" | "created_at"> & {
  responseCount?: number;
};

interface DocumentsPageClientProps {
  documents: DocSummary[];
  projectId?: string;
}

export function DocumentsPageClient({ documents, projectId }: DocumentsPageClientProps) {
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{
    ids: string[];
    totalResponses: number;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedDoc = documents.find((d) => d.id === selectedDocId) ?? null;

  function handleToggleSelect(docId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }

  function handleToggleAll(checked: boolean) {
    if (checked) {
      setSelectedIds(new Set(documents.map((d) => d.id)));
    } else {
      setSelectedIds(new Set());
    }
  }

  function handleRequestDeleteSingle(doc: DocumentSummary) {
    const full = documents.find((d) => d.id === doc.id);
    setDeleteTarget({
      ids: [doc.id],
      totalResponses: full?.responseCount ?? 0,
    });
  }

  function handleRequestDeleteSelected() {
    const totalResponses = documents
      .filter((d) => selectedIds.has(d.id))
      .reduce((sum, d) => sum + (d.responseCount ?? 0), 0);
    setDeleteTarget({ ids: Array.from(selectedIds), totalResponses });
  }

  function handleConfirmDelete() {
    if (!deleteTarget || !projectId) return;
    const { ids } = deleteTarget;
    const count = ids.length;
    startTransition(async () => {
      const result = await deleteDocuments(projectId, ids);
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success(
          count === 1
            ? "Documento excluído com sucesso"
            : `${count} documentos excluídos com sucesso`
        );
        setSelectedIds((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
        setDeleteTarget(null);
      }
    });
  }

  return (
    <>
      {projectId && selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-2">
          <span className="text-sm font-medium">
            {selectedIds.size} selecionado(s)
          </span>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleRequestDeleteSelected}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Excluir selecionados
          </Button>
        </div>
      )}

      <DocumentList
        documents={documents}
        onSelect={(doc) => setSelectedDocId(doc.id)}
        projectId={projectId}
        selectedIds={projectId ? selectedIds : undefined}
        onToggleSelect={projectId ? handleToggleSelect : undefined}
        onToggleAll={projectId ? handleToggleAll : undefined}
        onRequestDelete={projectId ? handleRequestDeleteSingle : undefined}
      />

      <DocumentPreview
        documentId={selectedDoc?.id ?? null}
        title={selectedDoc?.title ?? selectedDoc?.external_id ?? "Documento"}
        open={!!selectedDoc}
        onClose={() => setSelectedDocId(null)}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.ids.length === 1
                ? "Excluir documento?"
                : `Excluir ${deleteTarget?.ids.length} documentos?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && deleteTarget.totalResponses > 0 ? (
                <>
                  {deleteTarget.ids.length === 1
                    ? "Este documento"
                    : `Estes ${deleteTarget.ids.length} documentos`}{" "}
                  e suas{" "}
                  <strong>
                    {deleteTarget.totalResponses} resposta(s)
                  </strong>{" "}
                  serão excluídos permanentemente, incluindo revisões e atribuições associadas.
                </>
              ) : (
                <>
                  {deleteTarget?.ids.length === 1
                    ? "Este documento não possui respostas e"
                    : `Estes ${deleteTarget?.ids.length} documentos não possuem respostas e`}{" "}
                  será(ão) excluído(s) permanentemente.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Excluindo…
                </>
              ) : (
                "Excluir"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
