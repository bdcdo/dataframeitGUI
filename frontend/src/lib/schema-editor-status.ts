interface SchemaEditorStatus {
  isDirty: boolean;
  hasConflict: boolean;
  storageAvailable: boolean;
  draftPersisted: boolean;
  recoveredDraft: boolean;
}

export function schemaEditorStatusMessage({
  isDirty,
  hasConflict,
  storageAvailable,
  draftPersisted,
  recoveredDraft,
}: SchemaEditorStatus): string | null {
  if (!isDirty && !hasConflict) return null;
  if (hasConflict && draftPersisted) {
    return "Rascunho conflitante · aplique ou descarte antes de salvar";
  }
  if (hasConflict) {
    return "Rascunho conflitante não gravado localmente · sair pode perdê-lo";
  }
  if (!storageAvailable) {
    return "Alterações não salvas · o navegador avisará ao fechar ou recarregar; a navegação interna pode perdê-las";
  }
  if (!draftPersisted) {
    return "Alterações não salvas · o rascunho local não foi atualizado, possivelmente por outra aba";
  }
  if (recoveredDraft) return "Rascunho recuperado · alterações não salvas";
  return "Alterações não salvas · rascunho local";
}
