"use client";

import { useState, useTransition } from "react";
import { useRouter, usePathname } from "next/navigation";
import { DocumentList, type DocumentSummary } from "@/components/documents/DocumentList";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import {
  excludeDocuments,
  restoreDocuments,
  hardDeleteDocuments,
} from "@/actions/documents";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Trash2, Loader2, RotateCcw, FlameKindling } from "lucide-react";
import { toast } from "sonner";

type DocSummary = DocumentSummary & {
  created_at?: string;
};

interface DocumentsPageClientProps {
  documents: DocSummary[];
  projectId?: string;
  showExcluded?: boolean;
}

type ExcludeTarget = { ids: string[]; totalResponses: number };
type RestoreTarget = { ids: string[] };
type HardDeleteTarget = { ids: string[] };

export function DocumentsPageClient({
  documents,
  projectId,
  showExcluded = false,
}: DocumentsPageClientProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [excludeTarget, setExcludeTarget] = useState<ExcludeTarget | null>(null);
  const [excludeReason, setExcludeReason] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [hardDeleteTarget, setHardDeleteTarget] =
    useState<HardDeleteTarget | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedDoc = documents.find((d) => d.id === selectedDocId) ?? null;

  function handleToggleShowExcluded(checked: boolean) {
    if (!pathname) return;
    const url = checked ? `${pathname}?show=excluded` : pathname;
    setSelectedIds(new Set());
    router.push(url);
  }

  function handleToggleSelect(docId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }

  function handleToggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(documents.map((d) => d.id)) : new Set());
  }

  function handleRequestExcludeSingle(doc: DocumentSummary) {
    const full = documents.find((d) => d.id === doc.id);
    setExcludeTarget({
      ids: [doc.id],
      totalResponses: full?.responseCount ?? 0,
    });
    setExcludeReason("");
  }

  function handleRequestExcludeSelected() {
    const totalResponses = documents
      .filter((d) => selectedIds.has(d.id))
      .reduce((sum, d) => sum + (d.responseCount ?? 0), 0);
    setExcludeTarget({ ids: Array.from(selectedIds), totalResponses });
    setExcludeReason("");
  }

  function handleConfirmExclude() {
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
        setExcludeTarget(null);
        setExcludeReason("");
      }
    });
  }

  function handleRequestRestoreSingle(doc: DocumentSummary) {
    setRestoreTarget({ ids: [doc.id] });
  }

  function handleRequestRestoreSelected() {
    setRestoreTarget({ ids: Array.from(selectedIds) });
  }

  function handleConfirmRestore() {
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
        setRestoreTarget(null);
      }
    });
  }

  function handleRequestHardDeleteSingle(doc: DocumentSummary) {
    setHardDeleteTarget({ ids: [doc.id] });
  }

  function handleRequestHardDeleteSelected() {
    setHardDeleteTarget({ ids: Array.from(selectedIds) });
  }

  function handleConfirmHardDelete() {
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
        setHardDeleteTarget(null);
      }
    });
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
        <div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-2">
          <span className="text-sm font-medium">
            {selectedIds.size} selecionado(s)
          </span>
          {showExcluded ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRequestRestoreSelected}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Restaurar selecionados
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleRequestHardDeleteSelected}
              >
                <FlameKindling className="mr-1.5 h-3.5 w-3.5" />
                Apagar permanentemente
              </Button>
            </>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleRequestExcludeSelected}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Excluir selecionados
            </Button>
          )}
        </div>
      )}

      <DocumentList
        documents={documents}
        onSelect={(doc) => setSelectedDocId(doc.id)}
        projectId={projectId}
        selectedIds={projectId ? selectedIds : undefined}
        onToggleSelect={projectId ? handleToggleSelect : undefined}
        onToggleAll={projectId ? handleToggleAll : undefined}
        onRequestDelete={projectId ? handleRequestExcludeSingle : undefined}
        onRequestRestore={projectId ? handleRequestRestoreSingle : undefined}
        onRequestHardDelete={
          projectId ? handleRequestHardDeleteSingle : undefined
        }
        showExcluded={showExcluded}
      />

      <DocumentPreview
        documentId={selectedDoc?.id ?? null}
        title={selectedDoc?.title ?? selectedDoc?.external_id ?? "Documento"}
        open={!!selectedDoc}
        onClose={() => setSelectedDocId(null)}
      />

      {/* Soft delete (excluir = reversivel) */}
      <AlertDialog
        open={!!excludeTarget}
        onOpenChange={(open) => {
          if (!open) {
            setExcludeTarget(null);
            setExcludeReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {excludeTarget?.ids.length === 1
                ? "Excluir documento?"
                : `Excluir ${excludeTarget?.ids.length} documentos?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {excludeTarget && excludeTarget.totalResponses > 0 ? (
                <>
                  {excludeTarget.ids.length === 1
                    ? "Este documento"
                    : `Estes ${excludeTarget.ids.length} documentos`}{" "}
                  e suas{" "}
                  <strong>{excludeTarget.totalResponses} resposta(s)</strong>{" "}
                  serão ocultados das listas. A exclusão é reversível —
                  você pode restaurar ou apagar permanentemente depois em
                  &quot;Mostrar excluídos&quot;.
                </>
              ) : (
                <>
                  {excludeTarget?.ids.length === 1
                    ? "O documento"
                    : `Os ${excludeTarget?.ids.length} documentos`}{" "}
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
              value={excludeReason}
              onChange={(e) => setExcludeReason(e.target.value)}
              placeholder="Ex: parecer fora do escopo do projeto"
              rows={3}
              autoFocus
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmExclude}
              disabled={isPending || !excludeReason.trim()}
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

      {/* Restaurar */}
      <AlertDialog
        open={!!restoreTarget}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {restoreTarget?.ids.length === 1
                ? "Restaurar documento?"
                : `Restaurar ${restoreTarget?.ids.length} documentos?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {restoreTarget?.ids.length === 1
                ? "O documento voltará à lista ativa do projeto."
                : `Os ${restoreTarget?.ids.length} documentos voltarão à lista ativa do projeto.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmRestore}
              disabled={isPending}
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Restaurando…
                </>
              ) : (
                "Restaurar"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hard delete (apagar permanentemente) */}
      <AlertDialog
        open={!!hardDeleteTarget}
        onOpenChange={(open) => {
          if (!open) setHardDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {hardDeleteTarget?.ids.length === 1
                ? "Apagar permanentemente?"
                : `Apagar ${hardDeleteTarget?.ids.length} documentos permanentemente?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <strong>Esta ação não pode ser desfeita.</strong> O documento e
              todas as respostas, revisões e atribuições associadas serão
              removidos do banco de dados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmHardDelete}
              disabled={isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Apagando…
                </>
              ) : (
                "Apagar definitivamente"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
