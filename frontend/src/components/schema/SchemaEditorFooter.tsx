"use client";

import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DraftOrigin } from "@/hooks/useSchemaDraft";

interface SchemaEditorFooterProps {
  mode: "gui" | "code";
  saveDisabled: boolean;
  isDirty: boolean;
  conflictCount: number | null;
  storageAvailable: boolean;
  storageBlocked: boolean;
  draftPersisted: boolean;
  origin: DraftOrigin;
  onSave: () => void;
}

const ORIGIN_MESSAGE: Record<DraftOrigin, string> = {
  session: "Alterações não salvas · rascunho local",
  recovered: "Rascunho recuperado · alterações não salvas",
  rebased: "Mesclado com a versão mais recente · alterações não salvas",
};

function statusMessage({
  isDirty,
  conflictCount,
  storageAvailable,
  storageBlocked,
  draftPersisted,
  origin,
}: Omit<SchemaEditorFooterProps, "mode" | "saveDisabled" | "onSave">) {
  if (conflictCount !== null) {
    return conflictCount > 0
      ? `${conflictCount} conflito(s) pendente(s) · resolva antes de salvar`
      : "Conflitos resolvidos · confirme o merge para continuar";
  }
  if (!isDirty) return null;
  if (storageBlocked) {
    return "Alterações não salvas · outra aba possui o rascunho local";
  }
  if (!storageAvailable) {
    return "Alterações não salvas · o armazenamento local está indisponível";
  }
  if (!draftPersisted) return "Alterações não salvas · salvando rascunho local";
  return ORIGIN_MESSAGE[origin];
}

export function SchemaEditorFooter({
  mode,
  saveDisabled,
  isDirty,
  conflictCount,
  storageAvailable,
  storageBlocked,
  draftPersisted,
  origin,
  onSave,
}: SchemaEditorFooterProps) {
  if (mode === "code") return null;

  const message = statusMessage({
    isDirty,
    conflictCount,
    storageAvailable,
    storageBlocked,
    draftPersisted,
    origin,
  });

  return (
    <div className="flex items-center gap-2 border-t px-4 py-2">
      <Button
        size="sm"
        onClick={onSave}
        disabled={saveDisabled}
        className="bg-brand text-brand-foreground hover:bg-brand/90"
      >
        Salvar
      </Button>
      {message && (
        <output className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          {message}
        </output>
      )}
    </div>
  );
}
