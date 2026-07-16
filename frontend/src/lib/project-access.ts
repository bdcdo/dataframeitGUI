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
