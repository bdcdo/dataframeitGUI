import { describe, expect, it, vi } from "vitest";
import type { ResolvedProjectAccessContext } from "@/lib/auth";

vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => null }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => ({ from: () => ({}) }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({ from: () => ({}) }),
}));

const access: ResolvedProjectAccessContext = {
  status: "resolved",
  accountUserId: "master-1",
  memberUserId: "master-member",
  project: { id: "p1", name: "Projeto", created_by: "owner" },
  membershipRole: null,
  isMaster: true,
  isCoordinator: true,
};

describe("resolveProjectQueueIdentity — viewAs é somente leitura", () => {
  it("troca a fila sem substituir a conta autenticada ou seu membro próprio", async () => {
    const { resolveProjectQueueIdentity } = await import("@/lib/auth");

    const result = resolveProjectQueueIdentity(access, "member-viewed");

    expect(result).toEqual({
      ownMemberUserId: "master-member",
      queueUserId: "member-viewed",
      isImpersonating: true,
    });
    expect(result.queueUserId).not.toBe(access.accountUserId);
  });

  it("não-master não pode trocar a fila pela URL", async () => {
    const { resolveProjectQueueIdentity } = await import("@/lib/auth");

    expect(
      resolveProjectQueueIdentity(
        { ...access, isMaster: false, isCoordinator: false },
        "member-viewed",
      ),
    ).toEqual({
      ownMemberUserId: "master-member",
      queueUserId: "master-member",
      isImpersonating: false,
    });
  });
});
