/**
 * Regra da invariante `codificacao-concluida-response-so-rascunho`
 * (scripts/invariants/check-invariants.ts), separada da leitura do banco para
 * poder ser testada: o script faz os SELECTs e este módulo decide o que é
 * violação.
 */

interface ConcludedCodingAssignment {
  id: string;
  document_id: string;
  user_id: string;
  completed_at: string | null;
}

interface HumanLatestResponse {
  document_id: string;
  respondent_id: string | null;
  is_partial: boolean | null;
  /** NOT NULL com DEFAULT now() desde 20260514010000_responses_updated_at. */
  updated_at: string;
}

interface Violation {
  key: string;
  detail: string;
}

export interface ConcludedCodingDraftInput {
  /** Atribuições `type = 'codificacao'` com `status = 'concluido'`. */
  assignments: readonly ConcludedCodingAssignment[];
  /** Ids dos documentos não excluídos (`excluded_at IS NULL`). */
  activeDocIds: ReadonlySet<string>;
  /** Codificações humanas `is_latest`, de qualquer documento. */
  humanLatest: readonly HumanLatestResponse[];
}

/**
 * Envio incompleto DEPOIS da conclusão: desde o #608, `is_partial = true` é o
 * veredito da régua de completude sobre o conjunto enviado, e não mais só o
 * rascunho do auto-save. Um envio incompleto sobre codificação já concluída
 * (schema mudou entre abrir e enviar, #519) mantém o assignment concluído
 * (`keepCodingAssignmentInProgress`, #626) — estado legítimo. O que o separa
 * do rascunho promovido é a ordem: o saveResponse grava `updated_at` depois do
 * `completed_at` da conclusão. Estrito porque a promoção na criação (#538)
 * copia `completed_at = updated_at` da response que a sustenta: hoje só de
 * response enviada completa (guard de `is_partial` em coding-initial-status),
 * mas um canal que promovesse rascunho copiando o carimbo dele tem que
 * continuar acusado. Sem `completed_at` não há prova de reenvio, e a linha
 * segue como violação.
 */
function resubmittedAfterConclusion(
  completedAt: string | null,
  updatedAt: string,
): boolean {
  if (completedAt === null) return false;
  return Date.parse(updatedAt) > Date.parse(completedAt);
}

export function concludedCodingDraftViolations({
  assignments,
  activeDocIds,
  humanLatest,
}: ConcludedCodingDraftInput): Violation[] {
  // Response is_latest do par (única por (doc, respondente), garantida por
  // 'responses-is-latest-unica'). Só `is_partial === true` é candidato:
  // `undefined` (sem response) é caso de 'concluida-tem-response', `false` é
  // submetida e `null` é linha legada sem o sinal — conservador, para não
  // falso-positivar sem prova de rascunho.
  const latestOf = new Map(
    humanLatest.map((r) => [`${r.document_id}|${r.respondent_id}`, r]),
  );
  return assignments
    .filter((a) => {
      if (!activeDocIds.has(a.document_id)) return false;
      const response = latestOf.get(`${a.document_id}|${a.user_id}`);
      return (
        response?.is_partial === true &&
        !resubmittedAfterConclusion(a.completed_at, response.updated_at)
      );
    })
    .map((a) => ({
      key: a.id,
      detail: `assignment concluído cuja response is_latest é incompleta e não foi reenviada depois da conclusão (doc ${a.document_id}, user ${a.user_id})`,
    }));
}
