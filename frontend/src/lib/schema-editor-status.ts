interface SchemaEditorStatus {
  isDirty: boolean;
  conflictCount: number | null;
  storageAvailable: boolean;
  draftPersisted: boolean;
  recoveredDraft: boolean;
}

export function schemaEditorStatusMessage({
  isDirty,
  conflictCount,
  storageAvailable,
  draftPersisted,
  recoveredDraft,
}: SchemaEditorStatus): string | null {
  if (conflictCount !== null) {
    return conflictCount > 0
      ? `${conflictCount} conflito(s) pendente(s) · resolva antes de salvar`
      : "Conflitos resolvidos · confirme o merge para continuar";
  }
  if (!isDirty) return null;
  if (!storageAvailable) {
    return "Alterações não salvas · o armazenamento local está indisponível";
  }
  if (!draftPersisted) return "Alterações não salvas · salvando rascunho local";
  return recoveredDraft
    ? "Rascunho recuperado · alterações não salvas"
    : "Alterações não salvas · rascunho local";
}
