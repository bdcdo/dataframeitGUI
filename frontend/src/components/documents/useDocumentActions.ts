import { useState, useTransition } from "react";
import {
  excludeDocuments,
  restoreDocuments,
  hardDeleteDocuments,
} from "@/actions/documents";
import type { DocumentSummary } from "@/components/documents/DocumentList";
import { toast } from "sonner";

type DocSummary = DocumentSummary & { created_at?: string };

export type ExcludeTarget = { ids: string[]; totalResponses: number };
export type RestoreTarget = { ids: string[] };
export type HardDeleteTarget = { ids: string[] };

// Seleção de documentos + os 3 fluxos de exclude/restore/hard-delete
// (targets dos AlertDialogs, motivo da exclusão, submit e reset). Extraído
// do DocumentsPageClient para que o corpo do componente fique abaixo do
// limiar de useState do react-doctor.
export function useDocumentActions(
  projectId: string | undefined,
  documents: DocSummary[],
) {
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [excludeTarget, setExcludeTarget] = useState<ExcludeTarget | null>(null);
  const [excludeReason, setExcludeReason] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [hardDeleteTarget, setHardDeleteTarget] =
    useState<HardDeleteTarget | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggleSelect(docId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(documents.map((d) => d.id)) : new Set());
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function requestExcludeSingle(doc: DocumentSummary) {
    const full = documents.find((d) => d.id === doc.id);
    setExcludeTarget({
      ids: [doc.id],
      totalResponses: full?.responseCount ?? 0,
    });
    setExcludeReason("");
  }

  function requestExcludeSelected() {
    const totalResponses = documents
      .filter((d) => selectedIds.has(d.id))
      .reduce((sum, d) => sum + (d.responseCount ?? 0), 0);
    setExcludeTarget({ ids: Array.from(selectedIds), totalResponses });
    setExcludeReason("");
  }

  function closeExclude() {
    setExcludeTarget(null);
    setExcludeReason("");
  }

  function confirmExclude() {
    if (!excludeTarget || !projectId) return;
    if (!excludeReason.trim()) {
      toast.error("Informe o motivo da exclusão");
      return;
    }
    const { ids } = excludeTarget;
    const count = ids.length;
    startTransition(async () => {
      const result = await excludeDocuments(projectId, ids, excludeReason);
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success(
          count === 1
            ? "Documento excluído (reversível)"
            : `${count} documentos excluídos (reversíveis)`,
        );
        setSelectedIds(new Set());
        closeExclude();
      }
    });
  }

  function requestRestoreSingle(doc: DocumentSummary) {
    setRestoreTarget({ ids: [doc.id] });
  }

  function requestRestoreSelected() {
    setRestoreTarget({ ids: Array.from(selectedIds) });
  }

  function closeRestore() {
    setRestoreTarget(null);
  }

  function confirmRestore() {
    if (!restoreTarget || !projectId) return;
    const { ids } = restoreTarget;
    const count = ids.length;
    startTransition(async () => {
      const result = await restoreDocuments(projectId, ids);
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success(
          count === 1 ? "Documento restaurado" : `${count} documentos restaurados`,
        );
        setSelectedIds(new Set());
        closeRestore();
      }
    });
  }

  function requestHardDeleteSingle(doc: DocumentSummary) {
    setHardDeleteTarget({ ids: [doc.id] });
  }

  function requestHardDeleteSelected() {
    setHardDeleteTarget({ ids: Array.from(selectedIds) });
  }

  function closeHardDelete() {
    setHardDeleteTarget(null);
  }

  function confirmHardDelete() {
    if (!hardDeleteTarget || !projectId) return;
    const { ids } = hardDeleteTarget;
    const count = ids.length;
    startTransition(async () => {
      const result = await hardDeleteDocuments(projectId, ids);
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success(
          count === 1
            ? "Documento apagado permanentemente"
            : `${count} documentos apagados permanentemente`,
        );
        setSelectedIds(new Set());
        closeHardDelete();
      }
    });
  }

  return {
    selectedDocId,
    setSelectedDocId,
    selectedIds,
    toggleSelect,
    toggleAll,
    clearSelection,
    excludeTarget,
    excludeReason,
    setExcludeReason,
    restoreTarget,
    hardDeleteTarget,
    isPending,
    requestExcludeSingle,
    requestExcludeSelected,
    closeExclude,
    confirmExclude,
    requestRestoreSingle,
    requestRestoreSelected,
    closeRestore,
    confirmRestore,
    requestHardDeleteSingle,
    requestHardDeleteSelected,
    closeHardDelete,
    confirmHardDelete,
  };
}
