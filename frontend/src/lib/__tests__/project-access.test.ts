import { describe, it, expect } from "vitest";
import { requireResolvedProjectAccess } from "@/lib/project-access";

describe("requireResolvedProjectAccess", () => {
  const resolved = {
    status: "resolved" as const,
    accountUserId: "account-user",
    memberUserId: "member-user",
    project: null,
    membershipRole: null,
    isMaster: false,
    isCoordinator: false,
  };

  it("preserva o contexto resolvido", () => {
    expect(requireResolvedProjectAccess(resolved)).toBe(resolved);
  });

  it("interrompe a rota quando a identidade do projeto está indisponível", () => {
    expect(() =>
      requireResolvedProjectAccess({
        status: "unavailable",
      }),
    ).toThrow("Não foi possível verificar sua identidade no projeto.");
  });
});
