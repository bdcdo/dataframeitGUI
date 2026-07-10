import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeSession, type FakeSession } from "./auth-test-helpers";

// RC-005 (fail-closed) + classificação de estado da resolução de identidade
// (contracts/auth-resolution). `resolveAuth` é read-only e nunca repara vínculo
// no render (decisão D3): sessão sem vínculo confirmado NÃO vira `authenticated`
// nem `null` ambíguo — vira um estado recuperável explícito, para o layout
// redirecionar à conclusão de acesso em vez de mostrar dados protegidos.

// Sessão mutável lida pelos mocks (mesmo padrão de auth-effective-member).
let session: FakeSession;

vi.mock("@clerk/nextjs/server", () => ({
  currentUser: () => session.currentUser(),
  auth: async () => ({ userId: session.clerkUserId }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => session.admin(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => {
    throw new Error("createSupabaseServer não deve ser usado na resolução");
  },
}));

// Cada caso precisa de um cache() limpo — resetModules reimporta auth.ts fresco.
beforeEach(() => {
  vi.resetModules();
});

async function loadResolveAuth() {
  return (await import("@/lib/auth")).resolveAuth;
}

describe("resolveAuth — fail-closed (RC-005) e classificação de estado", () => {
  it("sem sessão Clerk → signed-out", async () => {
    session = makeFakeSession();
    // Sobrescreve currentUser para simular ausência de sessão.
    session.currentUser = async () => null;
    const resolveAuth = await loadResolveAuth();
    await expect(resolveAuth()).resolves.toEqual({ status: "signed-out" });
  });

  it("vínculo preparado e coerente → authenticated", async () => {
    session = makeFakeSession({ scenario: "prepared", supabaseUid: "sb_1" });
    const resolveAuth = await loadResolveAuth();
    const r = await resolveAuth();
    expect(r.status).toBe("authenticated");
    if (r.status === "authenticated") expect(r.user.id).toBe("sb_1");
  });

  it("sessão sem vínculo (pendente) → access-completion-required/link-pending", async () => {
    session = makeFakeSession({ scenario: "pending" });
    const resolveAuth = await loadResolveAuth();
    await expect(resolveAuth()).resolves.toEqual({
      status: "access-completion-required",
      reason: "link-pending",
    });
  });

  it("metadata e mapping divergentes → access-completion-required/link-divergent", async () => {
    session = makeFakeSession({ scenario: "divergent" });
    const resolveAuth = await loadResolveAuth();
    await expect(resolveAuth()).resolves.toEqual({
      status: "access-completion-required",
      reason: "link-divergent",
    });
  });

  it("sessão sem e-mail utilizável → technical-sync-failure", async () => {
    session = makeFakeSession({ scenario: "no-email" });
    const resolveAuth = await loadResolveAuth();
    await expect(resolveAuth()).resolves.toEqual({
      status: "technical-sync-failure",
      reason: "sync-temporary-failure",
    });
  });

  it("estado recuperável nunca vira authenticated (não expõe dados protegidos)", async () => {
    session = makeFakeSession({ scenario: "pending" });
    const resolveAuth = await loadResolveAuth();
    const r = await resolveAuth();
    expect(r.status).not.toBe("authenticated");
  });
});
