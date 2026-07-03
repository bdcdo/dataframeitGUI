"use client";

import { useRouter, usePathname } from "next/navigation";
import { DocumentList, type DocumentSummary } from "@/components/documents/DocumentList";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useDocumentActions } from "./useDocumentActions";
import { SelectedDocumentsBar } from "./SelectedDocumentsBar";
import { ExcludeDocumentsDialog } from "./ExcludeDocumentsDialog";
import { RestoreDocumentsDialog } from "./RestoreDocumentsDialog";
import { HardDeleteDocumentsDialog } from "./HardDeleteDocumentsDialog";

type DocSummary = DocumentSummary & {
  created_at?: string;
};

interface DocumentsPageClientProps {
  documents: DocSummary[];
  projectId?: string;
  showExcluded?: boolean;
}

export function DocumentsPageClient({
  documents,
  projectId,
  showExcluded = false,
}: DocumentsPageClientProps) {
  const { push } = useRouter();
  const pathname = usePathname();

  const {
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
  } = useDocumentActions(projectId, documents);

  const selectedDoc = documents.find((d) => d.id === selectedDocId) ?? null;

  function handleToggleShowExcluded(checked: boolean) {
    if (!pathname) return;
    const url = checked ? `${pathname}?show=excluded` : pathname;
    clearSelection();
    push(url);
  }

  return (
    <>
      {projectId && (
        <div className="flex items-center justify-end gap-3">
          <Label
            htmlFor="show-excluded"
            className="text-sm text-muted-foreground"
          >
            Mostrar excluídos
          </Label>
          <Switch
            id="show-excluded"
            checked={showExcluded}
            onCheckedChange={handleToggleShowExcluded}
          />
        </div>
      )}

      {projectId && selectedIds.size > 0 && (
        <SelectedDocumentsBar
          count={selectedIds.size}
          actions={
            showExcluded
              ? {
                  kind: "excluded",
                  onRestore: requestRestoreSelected,
                  onHardDelete: requestHardDeleteSelected,
                }
              : { kind: "active", onExclude: requestExcludeSelected }
          }
        />
      )}

      <DocumentList
        documents={documents}
        onSelect={(doc) => setSelectedDocId(doc.id)}
        projectId={projectId}
        selectedIds={projectId ? selectedIds : undefined}
        onToggleSelect={projectId ? toggleSelect : undefined}
        onToggleAll={projectId ? toggleAll : undefined}
        onRequestDelete={projectId ? requestExcludeSingle : undefined}
        onRequestRestore={projectId ? requestRestoreSingle : undefined}
        onRequestHardDelete={projectId ? requestHardDeleteSingle : undefined}
        showExcluded={showExcluded}
      />

      {projectId && (
        <DocumentPreview
          documentId={selectedDoc?.id ?? null}
          title={selectedDoc?.title ?? selectedDoc?.external_id ?? "Documento"}
          open={!!selectedDoc}
          onClose={() => setSelectedDocId(null)}
          projectId={projectId}
        />
      )}

      <ExcludeDocumentsDialog
        target={excludeTarget}
        reason={excludeReason}
        onReasonChange={setExcludeReason}
        isPending={isPending}
        onConfirm={confirmExclude}
        onClose={closeExclude}
      />

      <RestoreDocumentsDialog
        target={restoreTarget}
        isPending={isPending}
        onConfirm={confirmRestore}
        onClose={closeRestore}
      />

      <HardDeleteDocumentsDialog
        target={hardDeleteTarget}
        isPending={isPending}
        onConfirm={confirmHardDelete}
        onClose={closeHardDelete}
      />
    </>
  );
}
