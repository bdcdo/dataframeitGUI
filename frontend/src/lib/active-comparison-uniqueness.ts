/**
 * Regra da invariante `comparacao-ativa-unica-por-documento-e-rodada`
 * (scripts/invariants/check-invariants.ts), separada da leitura do banco para
 * poder ser testada: o script faz o SELECT e este módulo decide o que é
 * violação.
 *
 * Espelha `assignments_one_active_comparacao_per_doc_round`, que substituiu
 * `assignments_one_active_comparacao_per_doc` em 20260731120000, sobre
 * (document_id, round_id)
 * `WHERE type = 'comparacao' AND status IS DISTINCT FROM 'concluido'`:
 * - a chave tem round_id, então cada rodada tem a sua comparação ativa. A
 *   invariante (antes `comparacao-ativa-unica-por-documento`) ficou na chave
 *   do índice anterior (só document_id, de 20260716120100) e acusava como
 *   duplicata a comparação aberta de uma rodada ao lado da de outra, que o
 *   índice atual permite;
 * - status NULL conta como ativo (IS DISTINCT FROM);
 * - linha com NULL na chave não colide com nada (NULLS DISTINCT, ver
 *   `uniqueIndexViolations`): document_id é nullable desde 001_initial_schema.
 */

import { uniqueIndexViolations } from "@/lib/unique-index-violations";

export interface ComparisonAssignmentRow {
  id: string;
  document_id: string | null;
  round_id: string;
  status: string | null;
}

/** `rows` são as atribuições `type = 'comparacao'`; o filtro de status é daqui. */
export function activeComparisonUniquenessViolations(rows: readonly ComparisonAssignmentRow[]) {
  return uniqueIndexViolations(
    rows.filter((r) => r.status !== "concluido"),
    (r) => [r.document_id, r.round_id],
    "comparações ativas",
  );
}
