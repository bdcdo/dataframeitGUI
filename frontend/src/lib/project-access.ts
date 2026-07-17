import type { ProjectAccessContext } from "@/lib/auth";

// Mensagem única do fail-closed de identidade: a resolução não conclui se a
// identidade no projeto não pôde ser confirmada, e tanto o guard de página
// quanto as portas de mutation em auth.ts respondem a mesma coisa.
export const PROJECT_IDENTITY_UNAVAILABLE_MESSAGE =
  "Não foi possível verificar sua identidade no projeto.";

export function requireResolvedProjectAccess(
  access: ProjectAccessContext,
): Extract<ProjectAccessContext, { status: "resolved" }> {
  if (access.status === "unavailable") {
    throw new Error(PROJECT_IDENTITY_UNAVAILABLE_MESSAGE);
  }
  return access;
}

// Decisão única fail-open vs fail-closed sobre o resultado de
// `getProjectAccessContext` quando a página só precisa do papel de
// coordenador. Pura (sem import de server) para ser testável em isolamento —
// a fronteira de confiança não deve viver implícita numa expressão booleana
// espalhada por cada page.
//
// SEGURANÇA: `failOpen` só pode ser `true` onde `isCoordinator` liga apenas
// affordances que são re-checadas na mutation (`requireCoordinator`,
// fail-closed). Onde `isCoordinator` recorta DADOS por papel (fila de
// comparação, gabarito de terceiros) — ou onde a página precisa da identidade
// resolvida (`memberUserId`) — use `requireResolvedProjectAccess`: tratar
// "unavailable" como coordenador ali exporia dados de terceiros num erro
// transitório.
export function coordinatorGate(
  access: ProjectAccessContext,
  opts: { failOpen: boolean },
): boolean {
  if (access.status === "unavailable") return opts.failOpen;
  return access.isCoordinator;
}
