/**
 * Regra da invariante `responses-is-latest-unica`
 * (scripts/invariants/check-invariants.ts), separada da leitura do banco para
 * poder ser testada: o script faz o SELECT e este módulo decide o que é
 * violação.
 *
 * A chave de cada tipo de respondente é a do índice UNIQUE correspondente, sem
 * tirar nem pôr:
 * - LLM: `responses_one_latest_llm_per_document` (project_id, document_id),
 *   de 20260717120000. Sem round_id e sem respondent_id, que é NULL em toda
 *   linha LLM; o modelo (respondent_name) também não entra.
 * - humano: `responses_one_latest_human_per_document`
 *   (project_id, round_id, document_id, respondent_id), recriado em
 *   20260731120000 com round_id.
 *
 * Linha com NULL em alguma coluna da chave não colide com nada, como no índice
 * (NULLS DISTINCT), em vez de ser contada como índice dropado: project_id e
 * document_id são nullable desde 001_initial_schema, e humana viva sem
 * respondent_id é barrada pelo CHECK de 20260727120000, não pelo índice.
 *
 * Até a #715 a chave era `document_id|respondent_type|respondent_id`, que não
 * era a de nenhum dos dois: em linha LLM o respondent_id NULL caía para o
 * respondent_name, e duas LLM vivas de modelos diferentes passavam.
 */

import { groupBy } from "@/lib/utils";

export interface LatestResponseRow {
  id: string;
  project_id: string | null;
  round_id: string;
  document_id: string | null;
  respondent_type: "humano" | "llm";
  respondent_id: string | null;
}

interface Violation {
  key: string;
  detail: string;
}

/** Chave do índice que cobre a linha, ou null quando alguma coluna dela é NULL. */
function indexKey(r: LatestResponseRow): string | null {
  const columns =
    r.respondent_type === "llm"
      ? [r.project_id, r.document_id]
      : [r.project_id, r.round_id, r.document_id, r.respondent_id];
  return columns.includes(null) ? null : `${r.respondent_type}|${columns.join("|")}`;
}

export function latestResponseUniquenessViolations(
  rows: readonly LatestResponseRow[],
): Violation[] {
  const keyed = rows.flatMap((r) => {
    const key = indexKey(r);
    return key === null ? [] : [{ key, id: r.id }];
  });
  return [...groupBy(keyed, (r) => r.key)]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      detail: `${group.length} responses is_latest: ${group.map((r) => r.id).join(", ")}`,
    }));
}
