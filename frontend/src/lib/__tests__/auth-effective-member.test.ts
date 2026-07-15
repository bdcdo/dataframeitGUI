import { describe, it, expect, beforeEach, vi } from "vitest";

// getEffectiveMemberId (spec 002): resolve o membro canônico quando a conta
// atual é alias (member_email_links.linked_user_id) no projeto; senão, a
// própria conta. getAuthUser/getEffectiveMemberId usam React cache() — cada
// teste usa um projectId distinto para não colidir com memoização.
let aliasByProject: Record<string, { member_user_id: string } | null>;
let aliasErrorByProject: Record<string, { message: string } | null>;
let coordinatorByProject: Record<string, string | null>;
let memberEmailLinkQueries: number;
let membershipUserIds: string[];

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
  createSupabaseServer: async () => ({
    from: (table: string) => {
      let projectId: string | null = null;
      let userId: string | null = null;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (col: string, value: string) => {
        if (col === "project_id" || (table === "projects" && col === "id")) {
          projectId = value;
        }
        if (col === "user_id") userId = value;
        return builder;
      };
      builder.maybeSingle = async () => {
        if (table === "projects") {
          return {
            data: projectId
              ? { id: projectId, name: "Projeto", created_by: "owner" }
              : null,
            error: null,
          };
        }
        membershipUserIds.push(userId ?? "");
        return {
          data:
            projectId && coordinatorByProject[projectId] === userId
              ? { role: "coordenador" }
              : null,
          error: null,
        };
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "member_email_links") memberEmailLinkQueries += 1;
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
            error: projectId ? (aliasErrorByProject[projectId] ?? null) : null,
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
  aliasErrorByProject = {};
  coordinatorByProject = {};
  memberEmailLinkQueries = 0;
  membershipUserIds = [];
});

async function loadGetEffective() {
  return (await import("@/lib/auth")).getEffectiveMemberId;
}

async function loadResolveEffective() {
  return (await import("@/lib/auth")).resolveEffectiveUserId;
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

  it("falha de consulta não degrada silenciosamente para o id da conta", async () => {
    aliasErrorByProject = { pError: { message: "timeout" } };
    const getEffectiveMemberId = await loadGetEffective();
    await expect(getEffectiveMemberId("pError")).rejects.toThrow(
      "Falha ao resolver identidade efetiva do projeto",
    );
  });
});

// resolveEffectiveUserId: fonte única da precedência entre impersonação
// master (?viewAsUser=) e conta-alias, compartilhada por Codificar,
// Comparação e Arbitragem. Sem ela, Comparação/Arbitragem filtravam a fila
// pessoal pelo id do master logado e mostravam fila vazia na impersonação.
describe("resolveEffectiveUserId", () => {
  it("master + viewAsUser → impersona (precedência sobre alias)", async () => {
    aliasByProject = { pE: { member_user_id: "canonico1" } };
    const resolveEffectiveUserId = await loadResolveEffective();
    await expect(
      resolveEffectiveUserId("pE", { id: "acc1", isMaster: true }, "membro9"),
    ).resolves.toEqual({ effectiveUserId: "membro9", isImpersonating: true });
  });

  it("não-master ignora viewAsUser e resolve alias", async () => {
    aliasByProject = { pF: { member_user_id: "canonico1" } };
    const resolveEffectiveUserId = await loadResolveEffective();
    await expect(
      resolveEffectiveUserId("pF", { id: "acc1", isMaster: false }, "membro9"),
    ).resolves.toEqual({ effectiveUserId: "canonico1", isImpersonating: false });
  });

  it("master sem viewAsUser cai na resolução de alias/si próprio", async () => {
    aliasByProject = { pG: null };
    const resolveEffectiveUserId = await loadResolveEffective();
    await expect(
      resolveEffectiveUserId("pG", { id: "acc1", isMaster: true }, undefined),
    ).resolves.toEqual({ effectiveUserId: "acc1", isImpersonating: false });
  });
});

describe("isProjectCoordinator", () => {
  it("master retorna true sem consultar aliases nem contexto do projeto", async () => {
    aliasErrorByProject = { pMaster: { message: "timeout" } };
    const isProjectCoordinator = (await import("@/lib/auth"))
      .isProjectCoordinator;

    await expect(
      isProjectCoordinator("pMaster", {
        id: "master-1",
        email: "master@exemplo.com",
        firstName: "Master",
        lastName: null,
        clerkId: "clerk-master",
        isMaster: true,
      }),
    ).resolves.toBe(true);
    expect(memberEmailLinkQueries).toBe(0);
    expect(membershipUserIds).toEqual([]);
  });

  it("consulta o papel do membro canônico quando a conta atual é alias", async () => {
    aliasByProject = { pH: { member_user_id: "coord-canonico" } };
    coordinatorByProject = { pH: "coord-canonico" };
    const isProjectCoordinator = (await import("@/lib/auth"))
      .isProjectCoordinator;

    await expect(
      isProjectCoordinator("pH", {
        id: "acc1",
        email: "acc1@exemplo.com",
        firstName: "Conta",
        lastName: "Vinculada",
        clerkId: "clerk_acc1",
        isMaster: false,
      }),
    ).resolves.toBe(true);
    expect(membershipUserIds).toEqual(["coord-canonico"]);
  });
});
