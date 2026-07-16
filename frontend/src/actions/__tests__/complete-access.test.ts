import { describe, it, expect, vi, beforeEach } from "vitest";

// T014 (SC-007): concluir acesso é idempotente — repetir a ação para a mesma
// conta não cria vínculo/profile/membership duplicado. A idempotência mora na
// rotina única de reconciliação; este teste trava que a ação (a) a chama uma
// vez por tentativa e não faz nada não-idempotente por conta própria, (b)
// repetir a ação continua seguro e (c) qualquer falha fica recuperável.

let authImpl: () => Promise<{ userId: string | null }>;
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authImpl(),
}));

const reconcileClerkUserAccess = vi.fn<
  (clerkUserId: string) => Promise<string | null>
>(async () => "sb_user_1");
vi.mock("@/lib/clerk-sync", () => ({
  reconcileClerkUserAccess: (clerkUserId: string) =>
    reconcileClerkUserAccess(clerkUserId),
}));

import { completeAccess } from "@/actions/complete-access";

beforeEach(() => {
  reconcileClerkUserAccess.mockReset();
  reconcileClerkUserAccess.mockResolvedValue("sb_user_1");
  authImpl = async () => ({ userId: "clerk_1" });
});

describe("completeAccess — idempotência e falha segura", () => {
  it("reconcilia todo o acesso uma vez por tentativa e retorna ok", async () => {
    const result = await completeAccess();
    expect(result).toEqual({ ok: true });
    expect(reconcileClerkUserAccess).toHaveBeenCalledWith("clerk_1");
  });

  it("repetir a ação converge para o mesmo UUID (retry seguro)", async () => {
    await completeAccess();
    await completeAccess();
    const uids = reconcileClerkUserAccess.mock.results.map((r) => r.value);
    const resolved = await Promise.all(uids);
    expect(new Set(resolved)).toEqual(new Set(["sb_user_1"]));
  });

  it("sem sessão → falha recuperável sem chamar reconciliação", async () => {
    authImpl = async () => ({ userId: null });
    const result = await completeAccess();
    expect(result).toEqual({ ok: false, reason: "sync-temporary-failure" });
    expect(reconcileClerkUserAccess).not.toHaveBeenCalled();
  });

  it("estado Clerk sem identidade utilizável → falha temporária", async () => {
    reconcileClerkUserAccess.mockResolvedValueOnce(null);

    const result = await completeAccess();

    expect(result).toEqual({ ok: false, reason: "sync-temporary-failure" });
    expect(reconcileClerkUserAccess).toHaveBeenCalledWith("clerk_1");
  });

  it("erro no sync → unknown-recoverable, sem lançar", async () => {
    reconcileClerkUserAccess.mockRejectedValueOnce(new Error("boom interno"));
    const result = await completeAccess();
    expect(result).toEqual({ ok: false, reason: "unknown-recoverable" });
  });

  it("erro ao resolver alias ou ativar membro canônico não declara sucesso", async () => {
    reconcileClerkUserAccess.mockRejectedValueOnce(
      new Error("falha ao resolver alias"),
    );

    const result = await completeAccess();

    expect(result).toEqual({ ok: false, reason: "unknown-recoverable" });
  });

  it("erro ao ler a sessão fica contido como falha recuperável", async () => {
    authImpl = async () => {
      throw new Error("Clerk unavailable");
    };

    await expect(completeAccess()).resolves.toEqual({
      ok: false,
      reason: "unknown-recoverable",
    });
    expect(reconcileClerkUserAccess).not.toHaveBeenCalled();
  });
});
