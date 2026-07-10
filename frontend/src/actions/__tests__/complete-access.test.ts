import { describe, it, expect, vi, beforeEach } from "vitest";

// T014 (SC-007): concluir acesso é idempotente — repetir a ação para a mesma
// conta não cria vínculo/profile/membership duplicado. A idempotência mora nas
// rotinas relocadas (syncClerkUserToSupabase, activateProfileIfPending); este
// teste trava que a ação (a) as chama uma vez por tentativa e não faz nada
// não-idempotente por conta própria, (b) repetir a ação converge para o mesmo
// UUID, e (c) falha sem vazar detalhe técnico.

let currentUserImpl: () => Promise<unknown>;
vi.mock("@clerk/nextjs/server", () => ({
  currentUser: () => currentUserImpl(),
}));

const syncClerkUserToSupabase = vi.fn(async () => "sb_user_1");
const activateProfileIfPending = vi.fn(async () => {});
vi.mock("@/lib/clerk-sync", () => ({
  syncClerkUserToSupabase: (...args: unknown[]) =>
    syncClerkUserToSupabase(...(args as [])),
  activateProfileIfPending: (...args: unknown[]) =>
    activateProfileIfPending(...(args as [])),
}));

import { completeAccess } from "@/actions/complete-access";

const signedInUser = {
  id: "clerk_1",
  emailAddresses: [{ emailAddress: "ana@exemplo.com" }],
  firstName: "Ana",
  lastName: "Silva",
};

beforeEach(() => {
  syncClerkUserToSupabase.mockClear();
  activateProfileIfPending.mockClear();
  currentUserImpl = async () => signedInUser;
});

describe("completeAccess — idempotência e falha segura", () => {
  it("sincroniza e ativa uma vez por tentativa e retorna ok", async () => {
    const result = await completeAccess();
    expect(result).toEqual({ ok: true });
    expect(syncClerkUserToSupabase).toHaveBeenCalledTimes(1);
    expect(activateProfileIfPending).toHaveBeenCalledTimes(1);
    expect(activateProfileIfPending).toHaveBeenCalledWith("sb_user_1");
  });

  it("repetir a ação converge para o mesmo UUID (retry seguro)", async () => {
    await completeAccess();
    await completeAccess();
    // Cada tentativa chama o sync idempotente uma vez; ambas resolvem o mesmo
    // UUID — nenhuma duplicação é introduzida pela própria ação.
    const uids = syncClerkUserToSupabase.mock.results.map((r) => r.value);
    const resolved = await Promise.all(uids);
    expect(new Set(resolved)).toEqual(new Set(["sb_user_1"]));
  });

  it("sem e-mail utilizável → falha recuperável sem detalhe técnico", async () => {
    currentUserImpl = async () => ({ id: "clerk_1", emailAddresses: [] });
    const result = await completeAccess();
    expect(result).toEqual({ ok: false, reason: "sync-temporary-failure" });
    expect(syncClerkUserToSupabase).not.toHaveBeenCalled();
  });

  it("erro no sync → unknown-recoverable, sem lançar", async () => {
    syncClerkUserToSupabase.mockRejectedValueOnce(new Error("boom interno"));
    const result = await completeAccess();
    expect(result).toEqual({ ok: false, reason: "unknown-recoverable" });
  });
});
