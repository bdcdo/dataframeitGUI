// Conta ocorrências de user_id numa lista de linhas (assignments abertos) para
// balancear atribuições por menor carga. Usado por retryPendingComparisons,
// assignArbitrator e assignComparisonReviewer — mesmo loop, 3 sites.
export function buildLoadMap(rows: { user_id: string }[]): Map<string, number> {
  const loadByUser = new Map<string, number>();
  for (const r of rows) {
    loadByUser.set(r.user_id, (loadByUser.get(r.user_id) ?? 0) + 1);
  }
  return loadByUser;
}
