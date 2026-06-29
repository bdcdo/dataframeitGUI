// Tipos e fusão dos vereditos de revisão da Comparação.
//
// `localReviews` na UI é a sobreposição do que veio do servidor
// (`existingReviews`, prop) com os vereditos otimistas emitidos na sessão
// (`overrides`). Manter só os deltas em estado e derivar a visão mesclada por
// render evita copiar a prop para `useState` (react-doctor `no-derived-useState`)
// e, de quebra, deixa mudanças do servidor (após `revalidatePath`) fluírem para
// a tela — coisa que a cópia única de prop não fazia.

export interface VerdictInfo {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

/** Vereditos indexados por documento e depois por campo. */
export type ReviewsByDoc = Record<string, Record<string, VerdictInfo>>;

/**
 * Mescla os vereditos do servidor com os overrides otimistas. Override vence
 * por campo (merge raso por documento). Retorna a referência de `existing`
 * intacta quando não há nenhum override — assim o `useMemo` que a consome não
 * invalida memos a jusante à toa.
 */
export function mergeReviews(
  existing: ReviewsByDoc,
  overrides: ReviewsByDoc,
): ReviewsByDoc {
  const docIds = Object.keys(overrides);
  if (docIds.length === 0) return existing;

  const merged: ReviewsByDoc = { ...existing };
  for (const docId of docIds) {
    merged[docId] = { ...existing[docId], ...overrides[docId] };
  }
  return merged;
}
