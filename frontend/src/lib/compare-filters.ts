export interface CompareFiltersValue {
  version: string; // "all" | "latest_major" | "X.Y.Z"
  minHumans: number;
  minTotal: number;
  minAssignedPct: number;
  since: string; // yyyy-mm-dd or ""
  respondent: string; // "all" or name
}

export const DEFAULT_COMPARE_FILTERS: CompareFiltersValue = {
  // "all" (não "latest_major") por padrão: preserva codificações de schemas
  // anteriores na comparação. Elas contam, campo a campo, nos campos que não
  // mudaram (via answer_field_hashes / responseHadField) e são ignoradas só
  // nos campos que ainda não existiam quando foram feitas — em vez de descartar
  // a resposta inteira. O usuário pode escolher "latest_major" manualmente para
  // focar só na versão corrente.
  version: "all",
  minHumans: 2,
  minTotal: 2,
  minAssignedPct: 50,
  since: "",
  respondent: "all",
};

export function readCompareFilters(
  params: URLSearchParams | Record<string, string | undefined>,
  // Defaults aplicados quando o param não vem na URL. Por padrão são os globais
  // (DEFAULT_COMPARE_FILTERS); a página e o filtro passam os defaults derivados
  // do modo de automação (ver `compareDefaultsForMode`) para que o piso de
  // "mín. humanos" reflita o modo — sem isso, compare_llm (1 humano) nunca
  // alcançaria o piso fixo de 2 e a fila ficaria vazia.
  defaults: CompareFiltersValue = DEFAULT_COMPARE_FILTERS,
): CompareFiltersValue {
  const get = (k: string): string | undefined => {
    if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
    return params[k];
  };
  const toInt = (v: string | undefined, fallback: number) => {
    if (v === undefined) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    version: get("version") ?? defaults.version,
    minHumans: toInt(get("min_humans"), defaults.minHumans),
    minTotal: toInt(get("min_total"), defaults.minTotal),
    minAssignedPct: toInt(get("min_assigned_pct"), defaults.minAssignedPct),
    since: get("since") ?? defaults.since,
    respondent: get("respondent") ?? defaults.respondent,
  };
}

// Defaults da aba Comparar derivados do modo de automação do projeto
// (projects.automation_mode). O piso de "mín. humanos" espelha o gatilho que
// cria o assignment de comparação (createAutoComparisonIfDiverges em
// lib/auto-comparison.ts), para a lista da página não divergir de quando uma
// comparação é de fato materializada (mesmo princípio anti-drift de
// compare-version.ts / #217–#218):
//   - compare_llm    → 1 humano completo (a 2ª resposta exigida por minTotal=2
//                      é, na prática, o LLM)
//   - compare_humans → min_responses_for_comparison humanos
//   - auto_review_llm / none / desconhecido / null → default base (2)
// `mode` é string solta (não o tipo AutomationMode) de propósito: mantém este
// módulo de baixo nível sem depender de types.ts e tolera o valor null/legado
// de projetos antes da migration do automation_mode.
export function compareDefaultsForMode(
  mode: string | null | undefined,
  minResponsesForComparison: number,
): CompareFiltersValue {
  let minHumans = DEFAULT_COMPARE_FILTERS.minHumans;
  if (mode === "compare_llm") {
    minHumans = 1;
  } else if (mode === "compare_humans") {
    minHumans = Math.max(1, minResponsesForComparison);
  }
  return { ...DEFAULT_COMPARE_FILTERS, minHumans };
}

// Conjunto de document_ids que um usuário pode VER na fila de comparação.
// Coordenador → null (sem restrição: vê todos os documentos). Não-coordenador
// → apenas os docs com assignment de comparação atribuído a ele.
// SEGURANÇA: a policy RLS "Members view responses" deixa qualquer membro ler
// todas as responses do projeto, então este recorte é a única barreira de
// visibilidade — por isso o `isCoordinator` que o alimenta é fail-closed (não
// incorpora queryFailed). Ver analyze/compare/page.tsx.
export function assignedCompareDocIds(
  isCoordinator: boolean,
  assignments:
    | ReadonlyArray<{ document_id: string; user_id: string; type: string }>
    | null,
  userId: string,
): Set<string> | null {
  if (isCoordinator) return null;
  return new Set(
    (assignments ?? [])
      .filter((a) => a.type === "comparacao" && a.user_id === userId)
      .map((a) => a.document_id),
  );
}
