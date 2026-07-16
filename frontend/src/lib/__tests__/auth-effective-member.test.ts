import { beforeEach, describe, expect, it, vi } from "vitest";

interface AccessScenario {
  project: { id: string; name: string; created_by: string } | null;
  membershipRole: "coordenador" | "pesquisador" | null;
  projectError?: string;
  membershipError?: string;
}

let authenticated: boolean;
let authThrows: boolean;
let isMaster: boolean;
let aliasByIdentity: Record<string, { member_user_id: string } | null>;
let aliasErrorByIdentity: Record<string, { message: string } | null>;
let accessByProject: Record<string, AccessScenario>;
let memberEmailLinkQueries: number;
let membershipUserIds: string[];
let queryLimits: number[];
let serverQueries: number;

function aliasKey(projectId: string, accountUserId: string) {
  return `${projectId}:${accountUserId}`;
}

type QueryFilters = Map<string, string>;
type QueryResult = { data: unknown; error: { message: string } | null };
type QueryResolver = (table: string, filters: QueryFilters) => QueryResult;

interface QueryBuilder {
  select(): QueryBuilder;
  eq(column: string, value: string): QueryBuilder;
  limit(value: number): QueryBuilder;
  maybeSingle(): Promise<QueryResult>;
}

function makeQueryBuilder(table: string, resolve: QueryResolver): QueryBuilder {
  const filters: QueryFilters = new Map();
  const builder: QueryBuilder = {
    select: () => builder,
    eq: (column, value) => {
      filters.set(column, value);
      return builder;
    },
    limit: (value) => {
      queryLimits.push(value);
      return builder;
    },
    maybeSingle: () => Promise.resolve(resolve(table, filters)),
  };
  return builder;
}

function makeQueryClient(resolve: QueryResolver) {
  return {
    from: (table: string) => makeQueryBuilder(table, resolve),
  };
}

function filterValue(filters: QueryFilters, column: string) {
  return filters.get(column) ?? "";
}

function queryError(message: string | undefined) {
  return message ? { message } : null;
}

function resolveAdminQuery(table: string, filters: QueryFilters): QueryResult {
  if (table === "clerk_user_mapping") {
    return {
      data: { supabase_user_id: "acc1", access_sync_version: 1 },
      error: null,
    };
  }
  if (table === "master_users") {
    return {
      data: isMaster ? { user_id: filterValue(filters, "user_id") } : null,
      error: null,
    };
  }
  if (table === "member_email_links") {
    memberEmailLinkQueries += 1;
    const key = aliasKey(
      filterValue(filters, "project_id"),
      filterValue(filters, "linked_user_id"),
    );
    return {
      data: aliasByIdentity[key] ?? null,
      error: aliasErrorByIdentity[key] ?? null,
    };
  }
  return { data: null, error: null };
}

function accessScenario(projectId: string): AccessScenario {
  return (
    accessByProject[projectId] ?? {
      project: { id: projectId, name: "Projeto", created_by: "owner" },
      membershipRole: null,
    }
  );
}

function resolveProjectQuery(filters: QueryFilters): QueryResult {
  const scenario = accessScenario(filterValue(filters, "id"));
  return {
    data: scenario.project,
    error: queryError(scenario.projectError),
  };
}

function resolveMembershipQuery(filters: QueryFilters): QueryResult {
  const scenario = accessScenario(filterValue(filters, "project_id"));
  membershipUserIds.push(filterValue(filters, "user_id"));
  return {
    data: scenario.membershipRole ? { role: scenario.membershipRole } : null,
    error: queryError(scenario.membershipError),
  };
}

function resolveServerQuery(table: string, filters: QueryFilters): QueryResult {
  serverQueries += 1;
  return table === "projects"
    ? resolveProjectQuery(filters)
    : resolveMembershipQuery(filters);
}

vi.mock("@clerk/nextjs/server", () => ({
  currentUser: async () => {
    if (authThrows) throw new Error("Clerk indisponível");
    if (!authenticated) return null;
    return {
      id: "clerk_acc1",
      publicMetadata: { supabase_uid: "acc1" },
      primaryEmailAddressId: "email_primary",
      emailAddresses: [
        {
          id: "email_primary",
          emailAddress: "acc1@exemplo.com",
          verification: { status: "verified" },
        },
      ],
      firstName: "Conta",
      lastName: "Vinculada",
    };
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeQueryClient(resolveAdminQuery),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeQueryClient(resolveServerQuery),
}));

beforeEach(() => {
  vi.resetModules();
  authenticated = true;
  authThrows = false;
  isMaster = false;
  aliasByIdentity = {};
  aliasErrorByIdentity = {};
  accessByProject = {};
  memberEmailLinkQueries = 0;
  membershipUserIds = [];
  queryLimits = [];
  serverQueries = 0;
});

describe("resolveProjectMemberActor — membro canônico", () => {
  it("retorna o membro canônico sem consultar projeto ou membership", async () => {
    aliasByIdentity[aliasKey("p-alias", "acc1")] = {
      member_user_id: "canonical-1",
    };

    const { resolveProjectMemberActor } = await import("@/lib/auth");

    await expect(resolveProjectMemberActor("p-alias")).resolves.toMatchObject({
      ok: true,
      user: { id: "acc1" },
      memberUserId: "canonical-1",
    });
    expect(membershipUserIds).toEqual([]);
    expect(queryLimits).toEqual([1]);
  });

  it("sem alias retorna a própria conta", async () => {
    const { resolveProjectMemberActor } = await import("@/lib/auth");

    await expect(resolveProjectMemberActor("p-direct")).resolves.toMatchObject({
      ok: true,
      memberUserId: "acc1",
    });
    expect(membershipUserIds).toEqual([]);
  });

  it("alias de outro projeto não muda a identidade deste projeto", async () => {
    aliasByIdentity[aliasKey("p-other", "acc1")] = {
      member_user_id: "canonical-other",
    };

    const { resolveProjectMemberActor } = await import("@/lib/auth");

    await expect(resolveProjectMemberActor("p-current")).resolves.toMatchObject({
      ok: true,
      memberUserId: "acc1",
    });
  });

  it("falha técnica não degrada para o id bruto", async () => {
    aliasErrorByIdentity[aliasKey("p-error", "acc1")] = {
      message: "timeout",
    };

    const { resolveProjectMemberActor } = await import("@/lib/auth");

    await expect(resolveProjectMemberActor("p-error")).resolves.toEqual({
      ok: false,
      code: "identity_unavailable",
      error: "Não foi possível verificar sua identidade no projeto.",
    });
    expect(membershipUserIds).toEqual([]);
  });
});

describe("resolveProjectMemberActor", () => {
  it("distingue ausência de sessão de indisponibilidade técnica", async () => {
    authenticated = false;
    const { resolveProjectMemberActor } = await import("@/lib/auth");

    await expect(resolveProjectMemberActor("p-signed-out")).resolves.toEqual({
      ok: false,
      code: "unauthenticated",
      error: "Não autenticado",
    });

    vi.resetModules();
    authenticated = true;
    authThrows = true;
    const { resolveProjectMemberActor: resolveAfterFailure } = await import(
      "@/lib/auth"
    );

    await expect(resolveAfterFailure("p-failure")).resolves.toEqual({
      ok: false,
      code: "identity_unavailable",
      error: "Não foi possível verificar sua identidade no projeto.",
    });
  });

});

const projectUser = { id: "account-1", isMaster: false };

async function resolveProjectAccess(
  user: { id: string; isMaster: boolean } = projectUser,
) {
  const { getProjectAccessContext } = await import("@/lib/auth");
  return getProjectAccessContext("p1", user);
}

describe("getProjectAccessContext", () => {
  it("resolve conta direta e papel pesquisador", async () => {
    accessByProject.p1 = {
      project: { id: "p1", name: "Projeto", created_by: "owner" },
      membershipRole: "pesquisador",
    };

    const access = await resolveProjectAccess();

    expect(access).toMatchObject({
      status: "resolved",
      accountUserId: "account-1",
      memberUserId: "account-1",
      membershipRole: "pesquisador",
      isMaster: false,
      isCoordinator: false,
    });
    expect(membershipUserIds).toEqual(["account-1"]);
  });

  it("consulta papel somente do membro canônico da conta-alias", async () => {
    aliasByIdentity[aliasKey("p1", "account-1")] = {
      member_user_id: "canonical-coordinator",
    };
    accessByProject.p1 = {
      project: { id: "p1", name: "Projeto", created_by: "owner" },
      membershipRole: "coordenador",
    };

    const access = await resolveProjectAccess();

    expect(access).toMatchObject({
      status: "resolved",
      accountUserId: "account-1",
      memberUserId: "canonical-coordinator",
      membershipRole: "coordenador",
      isCoordinator: true,
    });
    expect(membershipUserIds).toEqual(["canonical-coordinator"]);
  });

  it("preserva ownership pela conta bruta", async () => {
    aliasByIdentity[aliasKey("p1", "account-1")] = {
      member_user_id: "canonical-researcher",
    };
    accessByProject.p1 = {
      project: { id: "p1", name: "Projeto", created_by: "account-1" },
      membershipRole: "pesquisador",
    };

    const access = await resolveProjectAccess();

    expect(access).toMatchObject({
      status: "resolved",
      memberUserId: "canonical-researcher",
      isCoordinator: true,
    });
  });

  it("master é coordenador no contexto resolvido", async () => {
    const access = await resolveProjectAccess({
      ...projectUser,
      isMaster: true,
    });

    expect(access).toMatchObject({
      status: "resolved",
      isMaster: true,
      isCoordinator: true,
    });
  });

  it("projeto não visível é estado resolvido sem acesso", async () => {
    accessByProject.p1 = { project: null, membershipRole: null };

    const access = await resolveProjectAccess();

    expect(access).toMatchObject({
      status: "resolved",
      project: null,
      isCoordinator: false,
    });
  });

  it("falha da identidade interrompe antes das queries de acesso", async () => {
    aliasErrorByIdentity[aliasKey("p1", "account-1")] = {
      message: "timeout",
    };

    await expect(resolveProjectAccess()).resolves.toEqual({
      status: "unavailable",
    });
    expect(serverQueries).toBe(0);
  });

  it("classifica falha técnica do projeto", async () => {
    accessByProject.p1 = {
      project: null,
      membershipRole: null,
      projectError: "timeout",
    };

    await expect(resolveProjectAccess()).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("classifica falha técnica da membership", async () => {
    accessByProject.p1 = {
      project: { id: "p1", name: "Projeto", created_by: "owner" },
      membershipRole: null,
      membershipError: "timeout",
    };

    await expect(resolveProjectAccess()).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("falha fechada quando as duas queries paralelas falham", async () => {
    accessByProject.p1 = {
      project: null,
      membershipRole: null,
      projectError: "project timeout",
      membershipError: "membership timeout",
    };

    await expect(resolveProjectAccess()).resolves.toEqual({
      status: "unavailable",
    });
  });
});

describe("resolveProjectQueueIdentity", () => {
  const aliasAccess = {
    status: "resolved" as const,
    accountUserId: "acc1",
    memberUserId: "canonical-1",
    project: { id: "p1", name: "Projeto", created_by: "owner" },
    membershipRole: "pesquisador" as const,
    isMaster: false,
    isCoordinator: false,
  };

  it("usa o membro canônico como dono e fila próprios", async () => {
    const { resolveProjectQueueIdentity } = await import("@/lib/auth");

    expect(resolveProjectQueueIdentity(aliasAccess, undefined)).toEqual({
      ownMemberUserId: "canonical-1",
      queueUserId: "canonical-1",
      isImpersonating: false,
    });
  });

  it("não-master ignora viewAsUser global", async () => {
    const { resolveProjectQueueIdentity } = await import("@/lib/auth");

    expect(resolveProjectQueueIdentity(aliasAccess, "member-9")).toEqual({
      ownMemberUserId: "canonical-1",
      queueUserId: "canonical-1",
      isImpersonating: false,
    });
  });

  it("master com viewAsUser preserva o dono e troca apenas a fila", async () => {
    const { resolveProjectQueueIdentity } = await import("@/lib/auth");

    expect(
      resolveProjectQueueIdentity(
        { ...aliasAccess, isMaster: true, isCoordinator: true },
        "member-9",
      ),
    ).toEqual({
      ownMemberUserId: "canonical-1",
      queueUserId: "member-9",
      isImpersonating: true,
    });
  });
});

describe("requireCoordinator", () => {
  it("classifica ausência de sessão", async () => {
    authenticated = false;
    const { requireCoordinator } = await import("@/lib/auth");

    await expect(requireCoordinator("p1", "Acesso negado")).resolves.toEqual({
      ok: false,
      code: "unauthenticated",
      error: "Não autenticado",
    });
  });

  it("classifica falta de papel", async () => {
    accessByProject.p1 = {
      project: { id: "p1", name: "Projeto", created_by: "owner" },
      membershipRole: "pesquisador",
    };
    const { requireCoordinator } = await import("@/lib/auth");

    await expect(requireCoordinator("p1", "Acesso negado")).resolves.toEqual({
      ok: false,
      code: "forbidden",
      error: "Acesso negado",
    });
  });

  it("classifica indisponibilidade sem rejeitar", async () => {
    aliasErrorByIdentity[aliasKey("p1", "acc1")] = { message: "timeout" };
    const { requireCoordinator } = await import("@/lib/auth");

    await expect(requireCoordinator("p1", "Acesso negado")).resolves.toEqual({
      ok: false,
      code: "authorization_unavailable",
      error: "Não foi possível verificar sua permissão. Tente novamente.",
    });
  });

  it("classifica falha da resolução autenticada sem rejeitar", async () => {
    authThrows = true;
    const { requireCoordinator } = await import("@/lib/auth");

    await expect(requireCoordinator("p1", "Acesso negado")).resolves.toEqual({
      ok: false,
      code: "authorization_unavailable",
      error: "Não foi possível verificar sua permissão. Tente novamente.",
    });
  });

  it("autoriza pelo papel do membro canônico", async () => {
    aliasByIdentity[aliasKey("p1", "acc1")] = {
      member_user_id: "canonical-coordinator",
    };
    accessByProject.p1 = {
      project: { id: "p1", name: "Projeto", created_by: "owner" },
      membershipRole: "coordenador",
    };
    const { requireCoordinator } = await import("@/lib/auth");

    const result = await requireCoordinator("p1", "Acesso negado");
    expect(result.ok).toBe(true);
    expect(membershipUserIds).toEqual(["canonical-coordinator"]);
  });

  it("master retorna antes da resolução de alias e projeto", async () => {
    isMaster = true;
    aliasErrorByIdentity[aliasKey("p1", "acc1")] = { message: "timeout" };
    const { requireCoordinator } = await import("@/lib/auth");

    const result = await requireCoordinator("p1", "Acesso negado");
    expect(result.ok).toBe(true);
    expect(memberEmailLinkQueries).toBe(0);
    expect(membershipUserIds).toEqual([]);
  });
});
