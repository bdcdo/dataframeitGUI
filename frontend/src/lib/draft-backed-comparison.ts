/**
 * Regra da invariante `comparacao-apoiada-so-em-rascunho`
 * (scripts/invariants/check-invariants.ts), separada da leitura do banco para
 * poder ser testada: o script faz os SELECTs e este módulo decide o que é
 * violação.
 */

interface ComparisonAssignment {
  id: string;
  document_id: string;
}

interface HumanLatestResponse {
  document_id: string;
  is_partial: boolean | null;
}

interface Violation {
  key: string;
  detail: string;
}

export interface DraftBackedComparisonInput {
  /** Todas as atribuições `type = 'comparacao'`, de qualquer documento. */
  comparisons: readonly ComparisonAssignment[];
  /** Ids dos documentos não excluídos (`excluded_at IS NULL`). */
  activeDocIds: ReadonlySet<string>;
  /** Codificações humanas `is_latest`, de qualquer documento. */
  humanLatest: readonly HumanLatestResponse[];
  /**
   * Exceções nominais: id da atribuição de comparação → rótulo do documento,
   * usado só na mensagem. A lista mora no script, junto da justificativa.
   */
  exceptions: ReadonlyMap<string, string>;
}

export function draftBackedComparisonViolations({
  comparisons,
  activeDocIds,
  humanLatest,
  exceptions,
}: DraftBackedComparisonInput): Violation[] {
  // Conta, por documento, quantas codificações humanas SUBMETIDAS existem.
  // `is_partial === true` é o único estado excluído: `null` é linha legada
  // sem o sinal e conta como submetida, mesma escolha conservadora de
  // 'codificacao-concluida-response-so-rascunho': não falso-positivar sem
  // prova de rascunho.
  const submittedByDoc = new Map<string, number>();
  const draftOnlyByDoc = new Map<string, number>();
  for (const r of humanLatest) {
    const bucket = r.is_partial === true ? draftOnlyByDoc : submittedByDoc;
    bucket.set(r.document_id, (bucket.get(r.document_id) ?? 0) + 1);
  }
  // Violação: existe comparação para o documento, mas NENHUMA codificação
  // humana submetida a sustenta, e há ao menos um rascunho, que é o que
  // explica a comparação ter sido criada. Sem essa segunda condição a
  // invariante também pegaria comparação órfã por response apagada, que é
  // outra família (e outra invariante).
  const draftBacked = comparisons.filter(
    (a) =>
      activeDocIds.has(a.document_id) &&
      (submittedByDoc.get(a.document_id) ?? 0) === 0 &&
      (draftOnlyByDoc.get(a.document_id) ?? 0) > 0,
  );
  const violations: Violation[] = draftBacked
    .filter((a) => !exceptions.has(a.id))
    .map((a) => ({
      key: a.id,
      detail: `comparação apoiada só em rascunho: doc ${a.document_id} tem ${draftOnlyByDoc.get(a.document_id)} codificação(ões) humana(s) nunca submetida(s) e nenhuma submetida`,
    }));

  // Exceção que não viola mais é entrada a remover, e vira violação para a
  // lista não acumular ids mortos: uma entrada esquecida suprimiria em silêncio
  // uma recaída futura na mesma atribuição. O motivo vai no detalhe porque
  // muda o que conferir antes de apagar a linha.
  const stillDraftBacked = new Set(draftBacked.map((a) => a.id));
  const docOf = new Map(comparisons.map((a) => [a.id, a.document_id]));
  for (const [id, label] of exceptions) {
    if (stillDraftBacked.has(id)) continue;
    const reason = obsoleteReason(docOf.get(id), activeDocIds, submittedByDoc);
    violations.push({
      key: id,
      detail: `exceção obsoleta (${label}): ${reason}; remover a entrada da lista de exceções`,
    });
  }
  return violations;
}

function obsoleteReason(
  docId: string | undefined,
  activeDocIds: ReadonlySet<string>,
  submittedByDoc: ReadonlyMap<string, number>,
): string {
  if (docId === undefined) return "a atribuição de comparação não existe mais";
  if (!activeDocIds.has(docId)) return `o doc ${docId} foi excluído`;
  if ((submittedByDoc.get(docId) ?? 0) > 0) return `o doc ${docId} já tem codificação humana submetida`;
  return `o doc ${docId} não tem mais codificação humana em rascunho`;
}
