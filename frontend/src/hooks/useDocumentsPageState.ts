"use client";

import { useState } from "react";

type ExcludeTarget = { ids: string[]; totalResponses: number };
type RestoreTarget = { ids: string[] };
type HardDeleteTarget = { ids: string[] };

/**
 * Estado de UI da página de documentos: seleção (preview + checkboxes em lote) e
 * os três dialogs de exclusão/restauração/remoção definitiva. Extraído de
 * `DocumentsPageClient` para reduzir o número de `useState` do container
 * (react-doctor `prefer-useReducer`); o ruleset não conta `useState` dentro de
 * custom hooks.
 */
export function useDocumentsPageState() {
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [excludeTarget, setExcludeTarget] = useState<ExcludeTarget | null>(null);
  const [excludeReason, setExcludeReason] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [hardDeleteTarget, setHardDeleteTarget] =
    useState<HardDeleteTarget | null>(null);

  return {
    selectedDocId,
    setSelectedDocId,
    selectedIds,
    setSelectedIds,
    excludeTarget,
    setExcludeTarget,
    excludeReason,
    setExcludeReason,
    restoreTarget,
    setRestoreTarget,
    hardDeleteTarget,
    setHardDeleteTarget,
  };
}
