import { describe, it, expect, beforeEach, vi } from "vitest";

// getEffectiveMemberId (spec 002): resolve o membro canônico quando a conta
// atual é alias (member_email_links.linked_user_id) no projeto; senão, a
// própria conta. getAuthUser/getEffectiveMemberId usam React cache() — cada
// teste usa um projectId distinto para não colidir com memoização.
let aliasByProject: Record<string, { member_user_id: string } | null>;

vi.mock("@clerk/nextjs/server", () => ({
  currentUser: async () => ({
    id: "clerk_acc1",
    publicMetadata: { supabase_uid: "acc1" },
    emailAddresses: [{ emailAddress: "acc1@exemplo.com" }],
    firstName: "Conta",
    lastName: "Vinculada",
  }),
}));

vi.mock("@/lib/clerk-sync", () => ({
  syncClerkUserToSupabase: async () => "acc1",
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => {
    throw new Error("não usado neste teste");
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => ({
    from: (table: string) => {
      let projectId: string | null = null;
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "is", "in", "order", "limit", "maybeSingle", "single", "update"]) {
        builder[m] = () => builder;
      }
      builder.eq = (col: string, value: string) => {
        if (col === "project_id") projectId = value;
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) => {
        if (table === "member_email_links") {
          return resolve({
            data: projectId ? (aliasByProject[projectId] ?? null) : null,
            error: null,
          });
        }
        if (table === "profiles") {
          return resolve({ data: { activated_at: "2026-01-01" }, error: null });
        }
        // master_users e demais lookups
        return resolve({ data: null, error: null });
      };
      return builder;
    },
  }),
}));

beforeEach(() => {
  aliasByProject = {};
});

async function loadGetEffective() {
  return (await import("@/lib/auth")).getEffectiveMemberId;
}

describe("getEffectiveMemberId", () => {
  it("com alias no projeto → retorna o member_user_id canônico", async () => {
    aliasByProject = { pA: { member_user_id: "canonico1" } };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pA")).resolves.toBe("canonico1");
  });

  it("sem alias no projeto → retorna o próprio user.id", async () => {
    aliasByProject = { pB: null };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pB")).resolves.toBe("acc1");
  });

  it("alias em outro projeto não vaza (efeito restrito ao projeto, FR-013)", async () => {
    aliasByProject = { pC: { member_user_id: "canonico1" }, pD: null };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pD")).resolves.toBe("acc1");
  });
});
