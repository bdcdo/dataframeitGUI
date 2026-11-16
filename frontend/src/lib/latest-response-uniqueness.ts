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
 *   20260731120000 com round_id. respondent_id não é NULL em humana viva
 *   (CHECK de 20260727120000).
 *
 * Até a #715 a chave era `document_id|respondent_type|respondent_id`, que não
 * era a de nenhum dos dois: em linha LLM o respondent_id NULL caía para o
 * respondent_name, e duas LLM vivas de modelos diferentes passavam.
 */

export interface LatestResponseRow {
  id: string;
  project_id: string;
  round_id: string;
  document_id: string;
  respondent_type: "humano" | "llm";
  respondent_id: string | null;
}

interface Violation {
  key: string;
  detail: string;
}

function indexKey(r: LatestResponseRow): string {
  return r.respondent_type === "llm"
    ? `llm|${r.project_id}|${r.document_id}`
    : `humano|${r.project_id}|${r.round_id}|${r.document_id}|${r.respondent_id}`;
}

export function latestResponseUniquenessViolations(
  rows: readonly LatestResponseRow[],
): Violation[] {
  const byKey = new Map<string, string[]>();
  for (const r of rows) {
    const key = indexKey(r);
    byKey.set(key, [...(byKey.get(key) ?? []), r.id]);
  }
  return [...byKey.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, detail: `${ids.length} responses is_latest: ${ids.join(", ")}` }));
}
