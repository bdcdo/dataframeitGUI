import { describe, it, expect } from "vitest";
import {
  coordinatorGate,
  requireResolvedProjectAccess,
} from "@/lib/project-access";

const resolved = {
  status: "resolved" as const,
  accountUserId: "account-user",
  memberUserId: "member-user",
  project: null,
  membershipRole: null,
  isMaster: false,
  isCoordinator: false,
};

const unavailable = { status: "unavailable" as const };

describe("requireResolvedProjectAccess", () => {
  it("preserva o contexto resolvido", () => {
    expect(requireResolvedProjectAccess(resolved)).toBe(resolved);
  });

  it("interrompe a rota quando a identidade do projeto está indisponível", () => {
    expect(() => requireResolvedProjectAccess(unavailable)).toThrow(
      "Não foi possível verificar sua identidade no projeto.",
    );
  });
});

describe("coordinatorGate", () => {
  it("com contexto resolvido, devolve o papel real independentemente do modo", () => {
    const coordinator = { ...resolved, isCoordinator: true };
    expect(coordinatorGate(coordinator, { failOpen: true })).toBe(true);
    expect(coordinatorGate(coordinator, { failOpen: false })).toBe(true);
    expect(coordinatorGate(resolved, { failOpen: true })).toBe(false);
    expect(coordinatorGate(resolved, { failOpen: false })).toBe(false);
  });

  it("fail-open: contexto indisponível não rebaixa o coordenador (affordance-only)", () => {
    expect(coordinatorGate(unavailable, { failOpen: true })).toBe(true);
  });

  it("fail-closed: contexto indisponível nega o papel", () => {
    expect(coordinatorGate(unavailable, { failOpen: false })).toBe(false);
  });
});
