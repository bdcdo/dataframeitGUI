// Decisão única fail-open vs fail-closed sobre o resultado de
// `getProjectAccessContext`. Pura (sem import de server) para ser testável em
// isolamento — a fronteira de confiança não deve viver implícita numa expressão
// booleana espalhada por cada page.
//
// SEGURANÇA: `failOpen` só pode ser `true` onde `isCoordinator` liga apenas
// affordances que são re-checadas na mutation (`isProjectCoordinator`,
// fail-closed). Onde `isCoordinator` recorta DADOS por papel (fila de
// comparação, gabarito de terceiros), use `failOpen: false` — incorporar
// `queryFailed` ali exporia dados de terceiros num erro transitório.
export function coordinatorGate(
  access: { isCoordinator: boolean; queryFailed: boolean } | null,
  opts: { failOpen: boolean },
): boolean {
  if (!access) return false;
  return opts.failOpen
    ? access.isCoordinator || access.queryFailed
    : access.isCoordinator;
}
