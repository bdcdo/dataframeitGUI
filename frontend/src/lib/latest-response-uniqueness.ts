/**
 * Regras das invariantes `responses-is-latest-unica` e
 * `response-humana-viva-tem-autor` (scripts/invariants/check-invariants.ts),
 * separadas da leitura do banco para poderem ser testadas: o script faz o
 * SELECT, um só para as duas, e este módulo decide o que é violação.
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
 * (NULLS DISTINCT), em vez de ser contada como índice dropado: document_id é
 * nullable desde 001_initial_schema (project_id também foi, até virar NOT NULL
 * em 20260731120000; o tipo segue aceitando null), e humana viva sem
 * respondent_id é barrada pelo CHECK de 20260727120000, não pelo índice
 * (ver `latestHumanWithoutActorViolations`).
 *
 * Até a #715 a chave era `document_id|respondent_type|respondent_id`, que não
 * era a de nenhum dos dois: em linha LLM o respondent_id NULL caía para o
 * respondent_name, e duas LLM vivas de modelos diferentes passavam.
 */

import { uniqueIndexViolations, type Violation } from "@/lib/unique-index-violations";

export interface LatestResponseRow {
  id: string;
  project_id: string | null;
  round_id: string;
  document_id: string | null;
  respondent_type: "humano" | "llm";
  respondent_id: string | null;
}

/** Colunas do índice que cobre a linha, prefixadas pelo tipo para os dois não se misturarem. */
function indexKeyColumns(r: LatestResponseRow): (string | null)[] {
  return r.respondent_type === "llm"
    ? ["llm", r.project_id, r.document_id]
    : ["humano", r.project_id, r.round_id, r.document_id, r.respondent_id];
}

export function latestResponseUniquenessViolations(
  rows: readonly LatestResponseRow[],
): Violation[] {
  return uniqueIndexViolations(rows, indexKeyColumns, "responses is_latest");
}

/**
 * Regra da invariante `response-humana-viva-tem-autor`: espelha o CHECK
 * `responses_human_latest_has_actor_check` (20260727120000),
 * `respondent_type <> 'humano' OR NOT is_latest OR respondent_id IS NOT NULL`,
 * inteiro: o script só lê linhas vivas, mas a regra não depende disso. CHECK
 * só rejeita quando a expressão dá FALSE, e `respondent_type` e `is_latest`
 * são NOT NULL, então não há braço de NULL a espelhar.
 */
export function latestHumanWithoutActorViolations(
  rows: readonly (Pick<LatestResponseRow, "id" | "respondent_type" | "respondent_id"> & {
    is_latest: boolean;
  })[],
): Violation[] {
  return rows
    .filter((r) => r.respondent_type === "humano" && r.is_latest && r.respondent_id === null)
    .map((r) => ({ key: r.id, detail: "response humana is_latest sem respondent_id" }));
}
