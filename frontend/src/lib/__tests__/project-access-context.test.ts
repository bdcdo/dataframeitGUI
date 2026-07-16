import { describe, it, expect, beforeEach, vi } from "vitest";

// US3 (T021/T022/T025): getProjectAccessContext preserva a autorização por
// projeto após o refactor do render path. Coordenador (criador/master/papel)
// mantém acesso de coordenação; pesquisador direto não; usuário sem projeto
// visível recebe negação fechada; falha técnica de query não vira "sem acesso"
// silencioso (queryFailed). A precedência de impersonação/alias é testada em
// auth-effective-member.test.ts (T023) e viewas-no-write.test.ts (T024).

interface Scenario {
  project: { id: string; name: string; created_by: string } | null;
  membershipRole: string | null;
  canonicalMemberId?: string;
  aliasError?: string;
  projectError?: string;
  membershipError?: string;
}

let scenario: Scenario;
let filters: Array<{ table: string; column: string; value: string }>;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (column: string, value: string) => {
        filters.push({ table, column, value });
        return builder;
      };
      builder.maybeSingle = async () => {
        if (table === "member_email_links") {
          return {
            data: scenario.canonicalMemberId
              ? { member_user_id: scenario.canonicalMemberId }
              : null,
            error: scenario.aliasError
              ? { message: scenario.aliasError }
              : null,
          };
        }
        if (table === "projects") {
          return {
            data: scenario.project,
            error: scenario.projectError
              ? { message: scenario.projectError }
              : null,
          };
        }
        // project_members
        return {
          data: scenario.membershipRole
            ? { role: scenario.membershipRole }
            : null,
          error: scenario.membershipError
            ? { message: scenario.membershipError }
            : null,
        };
      };
      return builder;
    },
  }),
}));

// getProjectAccessContext não usa admin nem Clerk, mas o módulo auth.ts importa
// ambos no topo — mocks mínimos para o import não explodir.
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => ({
    from: () => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq"]) builder[method] = () => builder;
      builder.maybeSingle = async () => ({ data: null, error: null });
      return builder;
    },
  }),
}));
vi.mock("@clerk/nextjs/server", () => ({
  currentUser: async () => ({
    id: "clerk_alias",
    publicMetadata: { supabase_uid: "alias_login" },
    emailAddresses: [{ emailAddress: "alias@example.com" }],
    firstName: "Alias",
    lastName: null,
  }),
}));

async function loadCtx() {
  return (await import("@/lib/auth")).getProjectAccessContext;
}

async function loadIsCoordinator() {
  return (await import("@/lib/auth")).isProjectCoordinator;
}

const projA = { id: "p1", name: "Projeto A", created_by: "owner_1" };

beforeEach(() => {
  vi.resetModules();
  filters = [];
});

describe("getProjectAccessContext — autorização preservada", () => {
  it("criador do projeto → coordenador", async () => {
    scenario = { project: projA, membershipRole: null };
    const ctx = await (await loadCtx())("p1", "owner_1", false);
    expect(ctx.isCoordinator).toBe(true);
    expect(ctx.queryFailed).toBe(false);
  });

  it("membro com papel coordenador → coordenador", async () => {
    scenario = { project: projA, membershipRole: "coordenador" };
    const ctx = await (await loadCtx())("p1", "outro_user", false);
    expect(ctx.isCoordinator).toBe(true);
  });

  it("conta alias consulta o membership da identidade canônica", async () => {
    scenario = {
      project: projA,
      membershipRole: "coordenador",
      canonicalMemberId: "member_canonical",
    };
    const ctx = await (await loadCtx())("p1", "login_alias", false);
    expect(ctx.effectiveUserId).toBe("member_canonical");
    expect(ctx.isCoordinator).toBe(true);
    expect(filters).toContainEqual({
      table: "project_members",
      column: "user_id",
      value: "member_canonical",
    });
  });

  it("master → coordenador mesmo sem membership", async () => {
    scenario = { project: projA, membershipRole: null };
    const ctx = await (await loadCtx())("p1", "master_user", true);
    expect(ctx.isCoordinator).toBe(true);
  });

  it("pesquisador direto (papel researcher) → NÃO coordenador", async () => {
    scenario = { project: projA, membershipRole: "researcher" };
    const ctx = await (await loadCtx())("p1", "pesq_1", false);
    expect(ctx.isCoordinator).toBe(false);
    expect(ctx.membershipRole).toBe("researcher");
  });

  it("projeto não visível na RLS → negação fechada (project null)", async () => {
    scenario = { project: null, membershipRole: null };
    const ctx = await (await loadCtx())("p1", "estranho", false);
    expect(ctx.project).toBeNull();
    expect(ctx.isCoordinator).toBe(false);
  });

  it("falha de query não vira 'sem acesso' silencioso (queryFailed)", async () => {
    scenario = {
      project: null,
      membershipRole: null,
      projectError: "timeout",
    };
    const ctx = await (await loadCtx())("p1", "coord", false);
    expect(ctx.queryFailed).toBe(true);
  });

  it("gate de mutation falha fechado quando a leitura de acesso é parcial", async () => {
    scenario = {
      project: projA,
      membershipRole: null,
      membershipError: "timeout",
    };
    const isProjectCoordinator = await loadIsCoordinator();

    await expect(
      isProjectCoordinator("p1", {
        id: "owner_1",
        email: "owner@example.com",
        firstName: "Owner",
        lastName: null,
        clerkId: "clerk_owner_1",
        isMaster: false,
      }),
    ).resolves.toBe(false);
  });

  it("requireCoordinator distingue falha técnica de acesso negado", async () => {
    scenario = {
      project: projA,
      membershipRole: null,
      membershipError: "timeout membership",
    };
    const { requireCoordinator } = await import("@/lib/auth");

    await expect(requireCoordinator("p1", "Acesso negado")).resolves.toEqual({
      ok: false,
      error: "Não foi possível verificar a permissão no projeto.",
    });
  });

  it("gates falham fechado quando a identidade canônica não pode ser resolvida", async () => {
    scenario = {
      project: projA,
      membershipRole: "coordenador",
      aliasError: "timeout alias",
    };
    const { isProjectCoordinator, requireCoordinator } = await import("@/lib/auth");
    const user = {
      id: "alias_login",
      email: "alias@example.com",
      firstName: "Alias",
      lastName: null,
      clerkId: "clerk_alias",
      isMaster: false,
    };

    await expect(isProjectCoordinator("p1", user)).resolves.toBe(false);
    await expect(requireCoordinator("p1", "Acesso negado")).resolves.toEqual({
      ok: false,
      error: "Não foi possível resolver a identidade no projeto.",
    });
  });
});
