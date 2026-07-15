import type { ProjectAccessContext } from "@/lib/auth";

export function requireResolvedProjectAccess(
  access: ProjectAccessContext,
): Extract<ProjectAccessContext, { status: "resolved" }> {
  if (access.status === "unavailable") {
    throw new Error("Não foi possível verificar sua identidade no projeto.");
  }
  return access;
}
