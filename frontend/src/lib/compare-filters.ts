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
    version: get("version") ?? DEFAULT_COMPARE_FILTERS.version,
    minHumans: toInt(get("min_humans"), DEFAULT_COMPARE_FILTERS.minHumans),
    minTotal: toInt(get("min_total"), DEFAULT_COMPARE_FILTERS.minTotal),
    minAssignedPct: toInt(
      get("min_assigned_pct"),
      DEFAULT_COMPARE_FILTERS.minAssignedPct,
    ),
    since: get("since") ?? DEFAULT_COMPARE_FILTERS.since,
    respondent: get("respondent") ?? DEFAULT_COMPARE_FILTERS.respondent,
  };
}
