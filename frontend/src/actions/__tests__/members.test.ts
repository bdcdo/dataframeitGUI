import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";

import {
  makeFilterAwareSupabaseMock,
  type QueryError,
  type ReadCall,
  type RpcCall,
  type RpcResult,
  type WriteCall,
} from "@/test-utils/supabase-mock";

let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let serverRows: Record<string, unknown[]>;
let adminRows: Record<string, unknown[]>;
let serverQueryErrors: Record<string, QueryError>;
let adminQueryErrors: Record<string, QueryError>;
let adminQueryErrorForCall: Parameters<typeof makeFilterAwareSupabaseMock>[0]["queryErrorForCall"];
let readCalls: ReadCall[];
const updateAuthUserById = vi.fn<
  (
    userId: string,
    attributes: { email: string; email_confirm: true },
  ) => Promise<{
    data: { user: { id: string } | null };
    error: { message: string } | null;
  }>
>(async (userId) => ({ data: { user: { id: userId } }, error: null }));

function makeClient(kind: "server" | "admin") {
  const client = makeFilterAwareSupabaseMock({
    tableData: kind === "server" ? serverRows : adminRows,
    queryErrors: kind === "server" ? serverQueryErrors : adminQueryErrors,
    queryErrorForCall: kind === "admin" ? adminQueryErrorForCall : undefined,
    writeCalls,
    readCalls,
    rpcCalls,
    rpcResults: kind === "server" ? serverRpcResults : adminRpcResults,
    projectColumns: true,
  });
  return { ...client, auth: { admin: { updateUserById: updateAuthUserById } } };
}

let serverRpcResults: Record<string, RpcResult | RpcResult[]>;
let adminRpcResults: Record<string, RpcResult | RpcResult[]>;
let adminCreateCalls: number;

const hoisted = vi.hoisted(() => ({
  revalidatePath: vi.fn<(path: string) => void>(),
  retry: vi.fn<
    (projectId: string) => Promise<{
      success: boolean;
      assigned: number;
      stillNoPool: number;
      error?: string;
    }>
  >(async () => ({
    success: true,
    assigned: 0,
    stillNoPool: 0,
  })),
  preregister: vi.fn<(email: string) => Promise<string>>(
    async () => "placeholderUid",
  ),
  reconcileClerkEmailOwner: vi.fn<
    (
      email: string,
    ) => Promise<
      | { status: "resolved"; userId: string; snapshotVersion: number }
      | { status: "unowned" }
      | { status: "changed" }
    >
  >(async () => ({ status: "unowned" })),
  retryComparisons: vi.fn<
    (projectId: string) => Promise<{
      success: boolean;
      assigned: number;
      stillNoPool: number;
      error?: string;
    }>
  >(async () => ({
    success: true,
    assigned: 0,
    stillNoPool: 0,
  })),
  requireCoordinator: vi.fn<
    (
      projectId: string,
      deniedMessage: string,
    ) => Promise<
      | { ok: true; user: { id: string } }
      | {
          ok: false;
          code: "authorization_unavailable";
          error: string;
        }
    >
  >(async () => ({ ok: true, user: { id: "userCoord" } })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: hoisted.revalidatePath,
}));
vi.mock("@/lib/auth", () => ({
  requireCoordinator: hoisted.requireCoordinator,
}));
// ClerkIdentityConflictError vem do módulo real: o instanceof que separa
// conflito estrutural de falha transitória exige a mesma classe dos dois lados.
vi.mock("@/lib/clerk-sync", async (importOriginal) => ({
  ClerkIdentityConflictError: (
    await importOriginal<typeof import("@/lib/clerk-sync")>()
  ).ClerkIdentityConflictError,
  preregisterSupabaseUser: hoisted.preregister,
  reconcileVerifiedClerkEmailOwner: hoisted.reconcileClerkEmailOwner,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeClient("server"),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => {
    adminCreateCalls++;
    return makeClient("admin");
  },
}));
vi.mock("@/actions/field-reviews", () => ({
  retryPendingArbitrations: hoisted.retry,
}));
vi.mock("@/actions/comparisons", () => ({
  retryPendingComparisons: hoisted.retryComparisons,
}));
// Erro do Postgres, PostgREST ou Auth não vai cru ao toast: o texto vai ao log
// do servidor, e a action devolve a copy pt-BR do fluxo (#502).
let consoleError: ReturnType<typeof vi.spyOn>;
function expectLogged(message: string) {
  expect(consoleError).toHaveBeenCalledWith(
    loggedLine(/\[members\] .* falhou/, { message }),
  );
}

afterEach(() => consoleError.mockRestore());

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  writeCalls = [];
  readCalls = [];
  serverRows = { project_members: [
    { id: "member1", project_id: "p-derived" },
    { id: "other", project_id: "other-project" },
  ] };
  adminRows = {};
  serverQueryErrors = {};
  adminQueryErrors = {};
  adminQueryErrorForCall = undefined;
  rpcCalls = [];
  serverRpcResults = {
    remove_project_member: {
      data: { project_id: "p-derived" },
    },
    set_member_arbitration_permission: {
      data: { project_id: "p-derived" },
    },
    set_member_comparison_permission: {
      data: { project_id: "p-derived" },
    },
  };
  adminRpcResults = {};
  adminCreateCalls = 0;
  updateAuthUserById.mockReset();
  updateAuthUserById.mockResolvedValue({
    data: { user: { id: "member1" } },
    error: null,
  });
  hoisted.revalidatePath.mockReset();
  hoisted.retry.mockReset();
  hoisted.retry.mockResolvedValue({
    success: true,
    assigned: 0,
    stillNoPool: 0,
  });
  hoisted.preregister.mockReset();
  hoisted.preregister.mockResolvedValue("placeholderUid");
  hoisted.reconcileClerkEmailOwner.mockReset();
  hoisted.reconcileClerkEmailOwner.mockResolvedValue({ status: "unowned" });
  hoisted.retryComparisons.mockReset();
  hoisted.retryComparisons.mockResolvedValue({
    success: true,
    assigned: 0,
    stillNoPool: 0,
  });
  hoisted.requireCoordinator.mockReset();
  hoisted.requireCoordinator.mockResolvedValue({
    ok: true,
    user: { id: "userCoord" },
  });
});

// O primeiro `import("@/actions/members")` carrega o grafo inteiro da server
// action; os seguintes saem do cache de módulos. Isolada, a carga leva perto de
// 400 ms contra poucos ms de um teste quente, mas com os workers da suíte
// disputando a CPU passa de 5 s e estourava o timeout do primeiro teste. O
// estouro ainda contaminava o teste seguinte: o Vitest não cancela o corpo que
// estourou, e as actions disparadas depois do import rodavam já com os mocks
// resetados pelo beforeEach seguinte. No hook, com prazo próprio, a carga deixa
// de contar contra os testes, sem mexer no timeout global.
beforeAll(async () => {
  await import("@/actions/members");
  await import("@/lib/clerk-sync");
}, 30_000);

function rpcArgs(fn: string): Record<string, unknown> {
  const call = rpcCalls.find((entry) => entry.fn === fn);
  return (call?.args as Record<string, unknown>) ?? {};
}
function expectNoWriteRpc(fn: string) {
  expect(rpcCalls.some((call) => call.fn === fn)).toBe(false);
}

async function loadRemove() {
  return (await import("@/actions/members")).removeMember;
}

describe("mutations com projectId explícito — gate canônico", () => {
  it("interrompe antes de efeitos quando a autorização está indisponível", async () => {
    hoisted.requireCoordinator.mockResolvedValue({
      ok: false,
      code: "authorization_unavailable",
      error: "Não foi possível verificar sua permissão. Tente novamente.",
    });
    const actions = await import("@/actions/members");

    const results = await Promise.all([
      actions.addMember("p1", "membro@exemplo.com", "pesquisador"),
      actions.updatePendingMemberEmail("p1", "member1", "novo@exemplo.com"),
      actions.linkMemberEmail("p1", "member1", "alias@exemplo.com"),
      actions.unifyMembers("p1", "source", "target", "source@example.com"),
      actions.unlinkMemberEmail("p1", "link1"),
    ]);

    expect(results).toEqual([
      ...Array.from({ length: 2 }, () => ({
        error: "Não foi possível verificar sua permissão. Tente novamente.",
      })),
      {
        status: "error",
        error: "Não foi possível verificar sua permissão. Tente novamente.",
      },
      ...Array.from({ length: 2 }, () => ({
        error: "Não foi possível verificar sua permissão. Tente novamente.",
      })),
    ]);
    expect(hoisted.requireCoordinator).toHaveBeenCalledTimes(5);
    expect(adminCreateCalls).toBe(0);
    expect(writeCalls).toEqual([]);
  });
});

describe("removeMember", () => {
  it("remove membership, pendências e aliases por uma RPC atômica", async () => {
    serverRpcResults.remove_project_member = {
      data: { project_id: "p-canonical" },
    };
    const remove = await loadRemove();
    const r = await remove("member-1");

    expect(r?.error).toBeUndefined();
    expect(rpcArgs("remove_project_member")).toEqual({
      p_member_id: "member-1",
    });
    expect(adminCreateCalls).toBe(0);
    expect(writeCalls).toEqual([]);
    expect(hoisted.revalidatePath).toHaveBeenCalledWith(
      "/projects/p-canonical",
    );
  });

  it("linha ausente → erro fail-closed", async () => {
    serverRpcResults.remove_project_member = { data: null };
    const remove = await loadRemove();

    expect(await remove("missing")).toEqual({
      error: "Membro não encontrado ou sem permissão.",
    });
    expect(adminCreateCalls).toBe(0);
  });

  it("falha transacional → propaga erro e não invalida cache", async () => {
    serverRpcResults.remove_project_member = {
      error: { message: "falha ao revogar alias" },
    };
    const remove = await loadRemove();

    expect(await remove("member-1")).toEqual({
      error: "falha ao revogar alias",
    });
    expect(hoisted.revalidatePath).not.toHaveBeenCalled();
  });
});

async function loadSet() {
  return (await import("@/actions/members")).setCanArbitrate;
}

describe("setCanArbitrate", () => {
  it("habilita via RPC e usa o projeto canônico no retry", async () => {
    hoisted.retry.mockResolvedValueOnce({
      success: true,
      assigned: 3,
      stillNoPool: 1,
    });
    const set = await loadSet();
    const r = await set("member1", true);
    expect(r.error).toBeUndefined();
    expect(r.retried).toEqual({ assigned: 3, stillNoPool: 1 });
    expect(hoisted.retry).toHaveBeenCalledWith("p-derived");
    expect(rpcArgs("set_member_arbitration_permission")).toEqual({
      p_member_id: "member1",
      p_enabled: true,
    });
    expect(adminCreateCalls).toBe(0);
    expect(writeCalls).toEqual([]);
  });

  it("desabilita atomicamente via RPC e dispara retry", async () => {
    hoisted.retry.mockResolvedValueOnce({
      success: true,
      assigned: 2,
      stillNoPool: 0,
    });
    const set = await loadSet();
    const r = await set("member1", false);
    expect(r.error).toBeUndefined();
    expect(hoisted.retry).toHaveBeenCalledWith("p-derived");
    expect(r.retried).toEqual({ assigned: 2, stillNoPool: 0 });
    expect(rpcArgs("set_member_arbitration_permission")).toEqual({
      p_member_id: "member1",
      p_enabled: false,
    });
    expect(adminCreateCalls).toBe(0);
  });

  it("habilita mas retry falha → result.retried undefined, sem propagar erro", async () => {
    hoisted.retry.mockResolvedValueOnce({
      success: false,
      error: "kaboom",
      assigned: 0,
      stillNoPool: 0,
    });
    const set = await loadSet();
    const r = await set("member1", true);
    // setCanArbitrate em si não falha — a RPC transacional deu certo.
    // O retry rodou em best-effort. Coordenador vê "habilitado" mas o banner
    // continua mostrando pendências se houver.
    expect(r.error).toBeUndefined();
    expect(r.retried).toBeUndefined();
  });

  it("RPC falha → retorna error e não dispara retry", async () => {
    serverRpcResults.set_member_arbitration_permission = {
      error: { message: "RLS bloqueou" },
    };
    const set = await loadSet();
    const r = await set("member1", true);
    expect(r.error).toEqual(copyWithRef("Não foi possível alterar a permissão do membro. Tente novamente."));
    expectLogged("RLS bloqueou");
    expect(hoisted.retry).not.toHaveBeenCalled();
  });

  it("RPC sem linha → erro fail-closed e não dispara retry", async () => {
    serverRpcResults.set_member_arbitration_permission = { data: null };
    const set = await loadSet();

    expect(await set("missing", false)).toEqual({
      error: "Membro não encontrado ou sem permissão.",
    });
    expect(hoisted.retry).not.toHaveBeenCalled();
  });
});

async function loadSetCompare() {
  return (await import("@/actions/members")).setCanCompare;
}

describe("setCanCompare", () => {
  it("desabilita atomicamente e usa o projeto canônico no retry", async () => {
    const set = await loadSetCompare();
    const r = await set("member-1", false);

    expect(r.error).toBeUndefined();
    expect(rpcArgs("set_member_comparison_permission")).toEqual({
      p_member_id: "member-1",
      p_enabled: false,
    });
    expect(hoisted.retryComparisons).toHaveBeenCalledWith("p-derived");
    expect(adminCreateCalls).toBe(0);
    expect(writeCalls).toEqual([]);
  });

  it("habilita via RPC e devolve a contagem do retry", async () => {
    hoisted.retryComparisons.mockResolvedValueOnce({
      success: true,
      assigned: 4,
      stillNoPool: 2,
    });
    const set = await loadSetCompare();

    expect(await set("member-1", true)).toEqual({
      retried: { assigned: 4, stillNoPool: 2 },
    });
    expect(rpcArgs("set_member_comparison_permission")).toEqual({
      p_member_id: "member-1",
      p_enabled: true,
    });
  });

  it("RPC falha → retorna error e não dispara retry", async () => {
    serverRpcResults.set_member_comparison_permission = {
      error: { message: "falha atômica" },
    };
    const set = await loadSetCompare();

    expect(await set("member-1", false)).toEqual({ error: copyWithRef("Não foi possível alterar a permissão do membro. Tente novamente.") });
    expectLogged("falha atômica");
    expect(hoisted.retryComparisons).not.toHaveBeenCalled();
  });

  it("retry falha após commit → mantém sucesso sem contagem", async () => {
    hoisted.retryComparisons.mockResolvedValueOnce({
      success: false,
      error: "retry indisponível",
      assigned: 0,
      stillNoPool: 0,
    });
    const set = await loadSetCompare();

    expect(await set("member-1", true)).toEqual({ retried: undefined });
    expect(hoisted.retryComparisons).toHaveBeenCalledWith("p-derived");
  });

  it("RPC sem linha → erro fail-closed e não dispara retry", async () => {
    serverRpcResults.set_member_comparison_permission = { data: null };
    const set = await loadSetCompare();

    expect(await set("missing", true)).toEqual({
      error: "Membro não encontrado ou sem permissão.",
    });
    expect(hoisted.retryComparisons).not.toHaveBeenCalled();
  });
});

async function loadChangeRole() {
  return (await import("@/actions/members")).changeRole;
}

describe("changeRole", () => {
  it("deriva o projeto da linha alterada", async () => {
    serverRows = { project_members: [
      { id: "member-1", project_id: "p-canonical" },
      { id: "other", project_id: "other-project" },
    ] };
    const change = await loadChangeRole();
    const r = await change("member-1", "coordenador");

    expect(r?.error).toBeUndefined();
    expect(hoisted.revalidatePath).toHaveBeenCalledWith(
      "/projects/p-canonical",
    );
  });

  it("linha ausente → erro fail-closed", async () => {
    serverRows = { project_members: [] };
    const change = await loadChangeRole();

    expect(await change("missing", "pesquisador")).toEqual({
      error: "Membro não encontrado ou sem permissão.",
    });
  });
});

async function loadSetResolve() {
  return (await import("@/actions/members")).setCanResolve;
}

describe("setCanResolve", () => {
  it("habilita e deriva o projeto sem disparar retry de arbitragem", async () => {
    const set = await loadSetResolve();
    const r = await set("member1", true);
    expect(r.error).toBeUndefined();
    expect(hoisted.retry).not.toHaveBeenCalled();
    expect(writeCalls).toContainEqual({
      table: "project_members",
      op: "update",
      payload: { can_resolve: true },
      filters: [["eq", "id", "member1"]],
    });
    expect(hoisted.revalidatePath).toHaveBeenCalledWith("/projects/p-derived");
  });

  it("desabilita → UPDATE com can_resolve=false", async () => {
    const set = await loadSetResolve();
    const r = await set("member1", false);
    expect(r.error).toBeUndefined();
    expect(writeCalls).toContainEqual({
      table: "project_members",
      op: "update",
      payload: { can_resolve: false },
      filters: [["eq", "id", "member1"]],
    });
  });

  it("UPDATE falha → retorna error", async () => {
    serverQueryErrors["project_members:update"] = { message: "RLS bloqueou" };
    const set = await loadSetResolve();
    const r = await set("member1", true);
    expect(r.error).toEqual(copyWithRef("Não foi possível alterar a permissão do membro. Tente novamente."));
    expectLogged("RLS bloqueou");
  });

  it("linha ausente → erro fail-closed", async () => {
    serverRows = { project_members: [] };
    const set = await loadSetResolve();

    expect(await set("missing", true)).toEqual({
      error: "Membro não encontrado ou sem permissão.",
    });
  });
});

async function loadAdd() {
  return (await import("@/actions/members")).addMember;
}

describe("addMember (pré-registro de membro sem conta)", () => {
  beforeEach(() => {
    adminRows = {
      profiles: [], member_email_links: [], clerk_user_mapping: [],
      project_members: [
        { id: "outside-project", project_id: "p2", user_id: "ownerUid" },
        { id: "other-member", project_id: "p1", user_id: "otherUid" },
      ],
    };
    adminRpcResults.add_project_member_with_identity_proof = { data: null };
  });
  function setAddCurrentOwnerContext({
    linkedOwner,
    projectMembers,
  }: {
    linkedOwner: string | null;
    projectMembers: boolean;
  }) {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "ownerUid",
      snapshotVersion: 101,
    });
    adminRows.profiles = [{ id: "ownerUid" }];
    adminRows.member_email_links = linkedOwner
      ? [{ id: "link1", project_id: "p1", email: "alias@conta.com", linked_user_id: "ownerUid", member_user_id: linkedOwner }]
      : [];
    adminRows.project_members = projectMembers
      ? [{ id: "membership1", project_id: "p1", user_id: "ownerUid" }]
      : [];
  }

  it("e-mail inválido → erro sem tocar no banco nem pré-registrar", async () => {
    const add = await loadAdd();
    const r = await add("p1", "sem-arroba", "pesquisador");
    expect(r.error).toBe("E-mail inválido.");
    expect(hoisted.preregister).not.toHaveBeenCalled();
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("normaliza e-mail (trim + lowercase) antes de pré-registrar", async () => {
    const add = await loadAdd();
    const r = await add("p1", "  Pessoa@Exemplo.COM ", "pesquisador");
    expect(r.error).toBeUndefined();
    expect(r.pending).toBe(true);
    expect(hoisted.requireCoordinator).toHaveBeenCalledWith(
      "p1",
      "Apenas coordenadores podem adicionar membros.",
    );
    expect(hoisted.preregister).toHaveBeenCalledWith("pessoa@exemplo.com");
    expect(rpcArgs("add_project_member_with_identity_proof")).toEqual({
      p_project_id: "p1",
      p_user_id: "placeholderUid",
      p_role: "pesquisador",
      p_email: "pessoa@exemplo.com",
      p_expected_snapshot_version: null,
    });
  });

  it("profile ativo histórico não bloqueia o dono Clerk atual distinto", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "ownerUid",
      snapshotVersion: 102,
    });
    adminRows.profiles = [
      { id: "legacyUid", email: "ja-tem@conta.com", activated_at: "2026-01-01" },
      { id: "ownerUid" },
    ];
    const add = await loadAdd();
    const r = await add("p1", "ja-tem@conta.com", "pesquisador");
    expect(r.error).toBeUndefined();
    expect(r.pending).toBe(false);
    expect(hoisted.preregister).not.toHaveBeenCalled();
    expect(hoisted.reconcileClerkEmailOwner).toHaveBeenCalledWith(
      "ja-tem@conta.com",
    );
    expect(readCalls.some((call) =>
      call.table === "project_members" &&
      call.filters.some((filter) => filter[0] === "eq" && filter[1] === "user_id" && filter[2] === "legacyUid"),
    )).toBe(false);
    expect(rpcArgs("add_project_member_with_identity_proof")).toMatchObject({
      p_project_id: "p1",
      p_user_id: "ownerUid",
      p_role: "pesquisador",
      p_expected_snapshot_version: 102,
    });
  });

  it("profile ativo que ainda é o dono Clerk mantém o bloqueio de duplicação", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "legacyUid",
      snapshotVersion: 103,
    });
    adminRows.profiles = [{ id: "legacyUid", email: "still-owned@conta.com", activated_at: "2026-01-01" }];
    adminRows.project_members = [{ id: "membership1", project_id: "p1", user_id: "legacyUid" }];
    const add = await loadAdd();

    expect(await add("p1", "still-owned@conta.com", "pesquisador")).toEqual({
      error: "Usuário já é membro deste projeto.",
    });
    expect(writeCalls.filter((call) => call.op === "insert")).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("profile existente mas ainda pendente (pré-registrado em outro projeto) → pending true", async () => {
    adminRows.profiles = [{ id: "placeholderUid2", email: "pendente@conta.com", activated_at: null }];
    const add = await loadAdd();
    const r = await add("p1", "pendente@conta.com", "pesquisador");
    expect(r.error).toBeUndefined();
    expect(r.pending).toBe(true);
    expect(hoisted.preregister).not.toHaveBeenCalled();
  });

  it("profile pendente já mapeado e sem dono exato não vira membership", async () => {
    adminRows.profiles = [{ id: "claimedUid", email: "antigo@exemplo.com", activated_at: null }];
    adminRows.clerk_user_mapping = [{ supabase_user_id: "claimedUid" }];
    const add = await loadAdd();

    expect(await add("p1", "antigo@exemplo.com", "pesquisador")).toEqual({
      error:
        "Este pré-registro já pertence a outra conta Clerk e não pode ser reutilizado.",
    });
    expect(hoisted.preregister).not.toHaveBeenCalled();
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("profile pendente mapeado só segue quando o dono exato resolve para o mesmo UID", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "claimedUid",
      snapshotVersion: 104,
    });
    adminRows.profiles = [{ id: "claimedUid", email: "atual@exemplo.com", activated_at: null }];
    adminRows.clerk_user_mapping = [{ supabase_user_id: "claimedUid" }];
    const add = await loadAdd();

    expect(await add("p1", "atual@exemplo.com", "pesquisador")).toEqual({
      pending: false,
    });
    expect(rpcArgs("add_project_member_with_identity_proof")).toMatchObject({
      p_project_id: "p1",
      p_user_id: "claimedUid",
      p_role: "pesquisador",
      p_expected_snapshot_version: 104,
    });
  });

  it("profile ativo sem dono Clerk confirmado → falha fechada", async () => {
    adminRows.profiles = [{ id: "existingUid", email: "ja-tem@conta.com", activated_at: "2026-01-01" }];
    const add = await loadAdd();

    expect(await add("p1", "ja-tem@conta.com", "pesquisador")).toEqual({
      error:
        "Não foi possível confirmar que a conta ativa ainda possui este e-mail.",
    });
    expect(writeCalls.filter((call) => call.op === "insert")).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("e-mail vinculado a outro membro do projeto → erro orientando a desvincular", async () => {
    adminRows.profiles = [{ id: "srcUid", email: "vinculado@conta.com", activated_at: "2026-01-01" }];
    adminRows.member_email_links = [{ project_id: "p1", email: "vinculado@conta.com", member_user_id: "target1" }];
    const add = await loadAdd();
    const r = await add("p1", "vinculado@conta.com", "pesquisador");
    expect(r.error).toContain("vinculado a outro membro");
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("falha no lookup de posse Clerk → fail-closed após validações locais", async () => {
    hoisted.reconcileClerkEmailOwner.mockRejectedValue(
      new Error("Clerk indisponível"),
    );
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error:
        "Não foi possível verificar a posse atual do e-mail. Tente novamente.",
    });
    expect(adminCreateCalls).toBe(1);
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("conflito estrutural de identidade não é oferecido como retry", async () => {
    // "Tente novamente" num conflito que nunca resolve deixa o coordenador em
    // loop; a mensagem precisa dizer o que está no caminho.
    const { ClerkIdentityConflictError } = await import("@/lib/clerk-sync");
    hoisted.reconcileClerkEmailOwner.mockRejectedValue(
      new ClerkIdentityConflictError(
        "Mais de uma conta Clerk possui o e-mail verificado",
      ),
    );
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error: "Mais de uma conta Clerk possui o e-mail verificado",
    });
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("falha na validação local → não consulta o Clerk", async () => {
    adminQueryErrors["profiles:select:id, activated_at"] = { message: "profiles indisponível" };
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error: copyWithRef("Não foi possível adicionar o membro. Tente novamente."),
    });
    expectLogged("profiles indisponível");
    expect(hoisted.reconcileClerkEmailOwner).not.toHaveBeenCalled();
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("posse alterada durante a operação não cria membership pendente", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({ status: "changed" });
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error: "A posse verificada do e-mail mudou. Tente novamente.",
    });
    expect(hoisted.preregister).not.toHaveBeenCalled();
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("dono Clerk reconciliado sem profile Supabase → falha fechada", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "ownerUid",
      snapshotVersion: 105,
    });
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error: "A conta verificada não possui profile Supabase.",
    });
    expect(writeCalls.filter((call) => call.op === "insert")).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("erro genérico no insert é propagado sem revalidar cache", async () => {
    adminRpcResults.add_project_member_with_identity_proof = { error: { message: "insert indisponível" } };
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error: copyWithRef("Não foi possível adicionar o membro. Tente novamente."),
    });
    expectLogged("insert indisponível");
    expect(hoisted.revalidatePath).not.toHaveBeenCalled();
  });

  it("membership do profile administrativo bloqueia duplicação antes da reconciliação", async () => {
    adminRows.profiles = [{ id: "existingUid", email: "ja-tem@conta.com", activated_at: null }];
    adminRows.project_members = [{ id: "membership1", project_id: "p1", user_id: "existingUid" }];
    const add = await loadAdd();

    expect(await add("p1", "ja-tem@conta.com", "pesquisador")).toEqual({
      error: "Usuário já é membro deste projeto.",
    });
    expect(hoisted.reconcileClerkEmailOwner).not.toHaveBeenCalled();
  });

  it("alias da conta por outro e-mail bloqueia uma membership terminal inválida", async () => {
    setAddCurrentOwnerContext({
      linkedOwner: "canonicalMember",
      projectMembers: false,
    });
    const add = await loadAdd();

    expect(await add("p1", "primary@conta.com", "pesquisador")).toEqual({
      error:
        "Esta conta já está vinculada a um membro do projeto. Desvincule-a antes de adicioná-la como membro próprio.",
    });
    expect(readCalls).toContainEqual(expect.objectContaining({
      table: "member_email_links",
      filters: [["eq", "project_id", "p1"], ["eq", "linked_user_id", "ownerUid"]],
    }));
    expect(writeCalls.filter((call) => call.op === "insert")).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("insert concorrente duplicado (23505) → mensagem de já membro", async () => {
    setAddCurrentOwnerContext({
      linkedOwner: null,
      projectMembers: false,
    });
    adminRpcResults.add_project_member_with_identity_proof = { error: { message: "duplicate key", code: "23505" } };
    const add = await loadAdd();

    expect(await add("p1", "ja-tem@conta.com", "pesquisador")).toEqual({
      error: "Usuário já é membro deste projeto.",
    });
  });

  it("falha no pré-registro → erro amigável, sem insert em project_members", async () => {
    hoisted.preregister.mockRejectedValueOnce(new Error("kaboom"));
    const add = await loadAdd();
    const r = await add("p1", "novo@exemplo.com", "pesquisador");
    expect(r.error).toBe("Não foi possível pré-registrar o membro. Tente novamente.");
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });

  it("conflito estrutural no pré-registro mantém a mensagem própria, sem retry", async () => {
    // O e-mail foi ativado (ou reclamado por uma conta Clerk) entre a leitura
    // local e o pré-registro: "tente novamente" falharia do mesmo jeito.
    const { ClerkIdentityConflictError } = await import("@/lib/clerk-sync");
    hoisted.preregister.mockRejectedValueOnce(
      new ClerkIdentityConflictError("Este e-mail já pertence a uma conta ativa"),
    );
    const add = await loadAdd();
    const r = await add("p1", "novo@exemplo.com", "pesquisador");
    expect(r.error).toBe("Este e-mail já pertence a uma conta ativa");
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
    expectNoWriteRpc("add_project_member_with_identity_proof");
  });
});

async function loadUpdatePendingEmail() {
  return (await import("@/actions/members")).updatePendingMemberEmail;
}

describe("updatePendingMemberEmail — lookups fail-closed", () => {
  beforeEach(() => {
    adminRows = {
      project_members: [
        { id: "pm1", project_id: "p1", user_id: "member1" },
        { id: "pm2", project_id: "p2", user_id: "member1" },
        { id: "pm3", project_id: "p3", user_id: "member1" },
      ],
      profiles: [{ id: "member1", activated_at: null }],
      member_email_links: [],
      clerk_user_mapping: [],
    };
  });
  it("delega a troca canônica ao Auth Admin sem duplicar a escrita do profile", async () => {
    const update = await loadUpdatePendingEmail();

    await expect(
      update("p1", "member1", " NOVO@EXEMPLO.COM "),
    ).resolves.toEqual({ otherProjectsCount: 2 });
    expect(updateAuthUserById).toHaveBeenCalledWith("member1", {
      email: "novo@exemplo.com",
      email_confirm: true,
    });
    expect(writeCalls).toEqual([]);
    expect(hoisted.revalidatePath).toHaveBeenCalledWith("/projects/p1");
  });

  it("propaga a rejeição transacional do Auth Admin sem publicar sucesso", async () => {
    updateAuthUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "placeholder reclamado" },
    });
    const update = await loadUpdatePendingEmail();

    await expect(update("p1", "member1", "novo@exemplo.com")).resolves.toEqual({
      error: copyWithRef("Não foi possível atualizar o e-mail. Tente novamente."),
    });
    expectLogged("placeholder reclamado");
    expect(hoisted.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "membership",
      key: "project_members:select:id",
      message: "membership indisponível",
    },
    {
      label: "perfil-alvo",
      key: "profiles:select:id, activated_at",
      message: "perfil-alvo indisponível",
    },
    {
      label: "dono do e-mail",
      key: "profiles:select:id",
      message: "dono indisponível",
    },
    {
      label: "vínculo do e-mail",
      filterColumn: "email",
      message: "vínculo indisponível",
    },
    {
      label: "alias resolvido",
      filterColumn: "member_user_id",
      message: "alias indisponível",
    },
  ])(
    "falha em $label interrompe antes de mutações",
    async ({ key, filterColumn, message }) => {
      if (key) adminQueryErrors[key] = { message };
      else adminQueryErrorForCall = ({ table, columns, filters }) =>
        table === "member_email_links" && columns === "id" &&
        filters.some(([kind, column]) => kind === "eq" && column === filterColumn)
          ? { message } : undefined;
      const update = await loadUpdatePendingEmail();

      expect(await update("p1", "member1", "novo@exemplo.com")).toEqual({
        error: copyWithRef("Não foi possível atualizar o e-mail. Tente novamente."),
      });
      expectLogged(message);
      expect(writeCalls).toEqual([]);
      expect(updateAuthUserById).not.toHaveBeenCalled();
    },
  );

  it("profile pendente já mapeado não pode ter o e-mail alterado", async () => {
    adminRows.clerk_user_mapping = [{ supabase_user_id: "member1", clerk_user_id: "clerk_1" }];
    const update = await loadUpdatePendingEmail();

    expect(await update("p1", "member1", "novo@exemplo.com")).toEqual({
      error:
        "Este membro já está vinculado a uma conta Clerk e não pode ter o e-mail de pré-registro alterado.",
    });
    expect(writeCalls).toEqual([]);
    expect(updateAuthUserById).not.toHaveBeenCalled();
  });

  it("falha ao verificar mapping interrompe antes de alterar auth/profile", async () => {
    adminQueryErrors["clerk_user_mapping:select:supabase_user_id"] = { message: "mapping indisponível" };
    const update = await loadUpdatePendingEmail();

    expect(await update("p1", "member1", "novo@exemplo.com")).toEqual({
      error: copyWithRef("Não foi possível verificar a identidade do membro. Tente novamente."),
    });
    expectLogged("mapping indisponível");
    expect(writeCalls).toEqual([]);
    expect(updateAuthUserById).not.toHaveBeenCalled();
  });
});

async function loadLink() {
  return (await import("@/actions/members")).linkMemberEmail;
}

describe("linkMemberEmail (vínculo de e-mails adicionais a um membro)", () => {
  beforeEach(() => {
    adminRows = {
      project_members: [
        { id: "membership1", project_id: "p1", user_id: "target1", role: "pesquisador" },
        { id: "outside-project", project_id: "p2", user_id: "target1", role: "pesquisador" },
        { id: "other-member", project_id: "p1", user_id: "otherUid", role: "pesquisador" },
      ],
      member_email_links: [],
      profiles: [],
      clerk_user_mapping: [],
    };
    adminRpcResults.preview_project_member_unification = { data: null };
    adminRpcResults.write_member_email_link_with_identity_proof = { data: LINK_ROW };
  });
  const LINK_ROW = {
    id: "link1",
    project_id: "p1",
    member_user_id: "target1",
    email: "extra@exemplo.com",
    linked_user_id: null,
    created_by: "userCoord",
    created_at: "2026-06-11T00:00:00Z",
  };
  type LinkRow = Omit<typeof LINK_ROW, "linked_user_id"> & { linked_user_id: string | null };

  const OWNER_PROFILE = {
    id: "acc1",
    first_name: "Atual",
    email: "primary@conta.com",
    activated_at: "2026-06-01T00:00:00Z",
  };
  const EMAIL_PROFILE = {
    id: "legacy1",
    first_name: "Legado",
    email: "extra@exemplo.com",
    activated_at: "2026-05-01T00:00:00Z",
  };

  function setCurrentOwnerLinkContext({
    ownerUserId = "acc1",
    initialLink = null,
    savedLink = LINK_ROW,
    profiles = [EMAIL_PROFILE, OWNER_PROFILE],
  }: {
    ownerUserId?: string;
    initialLink?: LinkRow | null;
    savedLink?: LinkRow;
    profiles?: Array<{ id: string; first_name: string | null; email: string; activated_at: string | null }>;
  } = {}) {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: ownerUserId,
      snapshotVersion: 106,
    });
    adminRows.member_email_links = initialLink ? [initialLink] : [];
    adminRows.profiles = profiles;
    adminRpcResults.write_member_email_link_with_identity_proof = { data: savedLink };
  }

  it("e-mail já vinculado a outro membro → valida antes de reconciliar", async () => {
    adminRows.member_email_links = [{ id: "l0", project_id: "p1", email: "extra@exemplo.com", member_user_id: "outro1" }];
    adminRows.profiles = [{ id: "outro1", first_name: "Ana", email: "ana@x.com" }];
    const link = await loadLink();
    const r = await link("p1", "target1", "extra@exemplo.com");
    expect(r).toEqual({
      status: "error",
      error: "Este e-mail já está vinculado a Ana neste projeto.",
    });
    expect(hoisted.reconcileClerkEmailOwner).not.toHaveBeenCalled();
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });

  it("target inexistente → valida antes de reconciliar", async () => {
    adminRows.project_members = [];
    const link = await loadLink();

    expect(await link("p1", "missing", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "Membro não encontrado neste projeto.",
    });
    expect(hoisted.reconcileClerkEmailOwner).not.toHaveBeenCalled();
  });

  it("falha no lookup Clerk após validação local → não cria vínculo", async () => {
    hoisted.reconcileClerkEmailOwner.mockRejectedValue(
      new Error("Clerk indisponível"),
    );
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error:
        "Não foi possível verificar a posse atual do e-mail. Tente novamente.",
    });
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });

  it("releitura após reconciliação perde o target → falha sem persistir", async () => {
    hoisted.reconcileClerkEmailOwner.mockImplementation(async () => {
      adminRows.project_members = [];
      return {
      status: "resolved",
      userId: "acc1",
      snapshotVersion: 107,
      };
    });
    adminRows.profiles = [OWNER_PROFILE];
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "Membro não encontrado neste projeto.",
    });
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });

  it("dono Clerk reconciliado sem profile Supabase → falha fechada", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "acc1",
      snapshotVersion: 108,
    });
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "A conta verificada não possui profile Supabase.",
    });
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });

  it("e-mail verificado da própria conta alvo → não cria auto-vínculo", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "target1",
      snapshotVersion: 109,
    });
    const targetProfile = { ...OWNER_PROFILE, id: "target1" };
    adminRows.profiles = [{ ...targetProfile, email: "extra@exemplo.com" }];
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "Este e-mail já pertence à conta deste membro.",
    });
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });

  it("profile administrativo que é membro → preview preserva linkEmail", async () => {
    adminRows.project_members = [
      { id: "membership1", project_id: "p1", user_id: "target1", role: "coordenador" },
      { id: "membership2", project_id: "p1", user_id: "src1", role: "pesquisador" },
    ];
    adminRows.profiles = [{
          id: "src1",
          first_name: "Beto",
          email: "beto@x.com",
          activated_at: null,
    }];
    adminRpcResults.preview_project_member_unification = {
      data: {
        assignments_to_migrate: 7,
        docs_with_both_responses: 1,
        review_conflicts: 1,
        arbitration_conflicts: 2,
        comparison_conflicts: 3,
      },
    };
    const link = await loadLink();
    const r = await link("p1", "target1", "beto@x.com");
    expect(r.status).toBe("requires-unification");
    if (r.status !== "requires-unification") throw new Error("preview ausente");
    expect(r.preview).toEqual({
      sourceUserId: "src1",
      sourceName: "Beto",
      targetUserId: "target1",
      assignmentsToMigrate: 7,
      docsWithBothResponses: 1,
      reviewConflicts: 1,
      arbitrationConflicts: 2,
      comparisonConflicts: 3,
      resultingRole: "coordenador",
      linkEmail: "beto@x.com",
    });
    expect(rpcArgs("preview_project_member_unification")).toEqual({
      p_project_id: "p1",
      p_source_user_id: "src1",
      p_target_user_id: "target1",
    });
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });

  it("falha na RPC de preview → não persiste vínculo", async () => {
    adminRows.profiles = [EMAIL_PROFILE];
    adminRows.project_members.push({ id: "membership2", project_id: "p1", user_id: "legacy1", role: "pesquisador" });
    adminRpcResults.preview_project_member_unification = {
      error: { message: "preview indisponível" },
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: copyWithRef("Não foi possível preparar a unificação dos membros. Tente novamente."),
    });
    expectLogged("preview indisponível");
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });

  it("dono atual e placeholder com o mesmo id geram um único preview", async () => {
    const pendingOwner = { ...OWNER_PROFILE, activated_at: null };
    setCurrentOwnerLinkContext({
      profiles: [{ ...pendingOwner, email: "extra@exemplo.com" }],
    });
    adminRpcResults.preview_project_member_unification = {
      data: {
        assignments_to_migrate: 1,
        docs_with_both_responses: 0,
        review_conflicts: 0,
        arbitration_conflicts: 0,
        comparison_conflicts: 0,
      },
    };
    const link = await loadLink();

    expect((await link("p1", "target1", "extra@exemplo.com")).status).toBe(
      "requires-unification",
    );
    expect(
      rpcCalls.filter(
        (call) => call.fn === "preview_project_member_unification",
      ),
    ).toHaveLength(1);
  });

  it("conta Clerk atual não-membro → usa ownerProfile e marca acesso pronto", async () => {
    setCurrentOwnerLinkContext({
      savedLink: { ...LINK_ROW, linked_user_id: "acc1" },
    });
    const link = await loadLink();
    const r = await link("p1", "target1", "Extra@Exemplo.com");
    expect(r.status).toBe("linked");
    if (r.status !== "linked") throw new Error("vínculo ausente");
    expect(r.link.linked_user_id).toBe("acc1");
    expect(r.access).toBe("ready");
    expect(rpcArgs("write_member_email_link_with_identity_proof")).toEqual({
      p_project_id: "p1",
      p_member_user_id: "target1",
      p_email: "extra@exemplo.com",
      p_linked_user_id: "acc1",
      p_created_by: "userCoord",
      p_existing_link_id: null,
      p_expected_linked_user_id: null,
      p_expected_snapshot_version: 106,
    });
    expect(hoisted.reconcileClerkEmailOwner).toHaveBeenCalledWith(
      "extra@exemplo.com",
    );
  });

  it("link antigo do mesmo target converge do placeholder para o dono atual", async () => {
    const staleLink = { ...LINK_ROW, linked_user_id: "legacy1" };
    const resolvedLink = { ...LINK_ROW, linked_user_id: "acc1" };
    setCurrentOwnerLinkContext({
      initialLink: staleLink,
      savedLink: resolvedLink,
    });
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "linked",
      link: resolvedLink,
      access: "ready",
    });
    expect(
      rpcArgs("write_member_email_link_with_identity_proof"),
    ).toMatchObject({
      p_existing_link_id: "link1",
      p_expected_linked_user_id: "legacy1",
      p_linked_user_id: "acc1",
      p_expected_snapshot_version: 106,
    });
  });

  it("ignora profile ativo histórico quando o Clerk confirma outro dono atual", async () => {
    setCurrentOwnerLinkContext({
      savedLink: { ...LINK_ROW, linked_user_id: "acc1" },
    });
    const link = await loadLink();
    const result = await link("p1", "target1", "extra@exemplo.com");

    expect(result).toMatchObject({
      status: "linked",
      access: "ready",
      link: { linked_user_id: "acc1" },
    });
    expect(
      rpcCalls
        .filter((call) => call.fn === "preview_project_member_unification")
        .map((call) => call.args),
    ).toEqual([
      {
        p_project_id: "p1",
        p_source_user_id: "acc1",
        p_target_user_id: "target1",
      },
    ]);
  });

  it("placeholder pendente e dono atual membros → não adivinha a origem", async () => {
    setCurrentOwnerLinkContext({
      profiles: [{ ...EMAIL_PROFILE, activated_at: null }, OWNER_PROFILE],
    });
    adminRows.project_members.push(
      { id: "membership2", project_id: "p1", user_id: "legacy1", role: "pesquisador" },
      { id: "membership3", project_id: "p1", user_id: "acc1", role: "pesquisador" },
    );
    const conflictPreview = {
      data: {
        assignments_to_migrate: 1,
        docs_with_both_responses: 0,
        review_conflicts: 0,
        arbitration_conflicts: 0,
        comparison_conflicts: 0,
      },
    };
    adminRpcResults.preview_project_member_unification = [
      conflictPreview,
      conflictPreview,
    ];
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error:
        "O e-mail envolve mais de uma identidade existente no projeto; resolva-as separadamente.",
    });
    expect(rpcCalls.filter((call) => call.fn === "preview_project_member_unification")
      .map((call) => (call.args as { p_source_user_id: string }).p_source_user_id)
      .sort()).toEqual(["acc1", "legacy1"]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });

  it("profile ativo sem dono Clerk confirmado → falha fechada", async () => {
    adminRows.profiles = [EMAIL_PROFILE];
    adminRows.project_members.push({ id: "membership2", project_id: "p1", user_id: "legacy1", role: "pesquisador" });
    adminRpcResults.preview_project_member_unification = {
      data: {
        assignments_to_migrate: 1,
        docs_with_both_responses: 0,
        review_conflicts: 0,
        arbitration_conflicts: 0,
        comparison_conflicts: 0,
      },
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error:
        "O e-mail pertence a um membro ativo, mas sua posse atual não pôde ser confirmada no Clerk.",
    });
  });

  it("profile pendente já mapeado e sem dono exato não vira vínculo", async () => {
    adminRows.profiles = [{
          id: "claimedUid",
          first_name: null,
          email: "extra@exemplo.com",
          activated_at: null,
    }];
    adminRows.clerk_user_mapping = [{ supabase_user_id: "claimedUid" }];
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error:
        "Este e-mail pertence a uma identidade Clerk diferente e não pode ser reutilizado como pré-registro.",
    });
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });

  it("posse alterada durante a operação não degrada para vínculo pendente", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({ status: "changed" });
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "A posse verificada do e-mail mudou. Tente novamente.",
    });
    expect(writeCalls).toEqual([]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });

  it("profile pré-registrado preserva a identidade conhecida como pendente", async () => {
    const knownPendingLink = {
      ...LINK_ROW,
      linked_user_id: "placeholder1",
    };
    adminRows.profiles = [{
          id: "placeholder1",
          first_name: null,
          email: "extra@exemplo.com",
          activated_at: null,
    }];
    adminRpcResults.write_member_email_link_with_identity_proof = { data: knownPendingLink };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "linked",
      link: knownPendingLink,
      access: "pending",
    });
    expect(
      rpcArgs("write_member_email_link_with_identity_proof"),
    ).toMatchObject({
      p_existing_link_id: null,
      p_linked_user_id: "placeholder1",
      p_expected_snapshot_version: null,
    });
    expect(hoisted.reconcileClerkEmailOwner).toHaveBeenCalledWith(
      "extra@exemplo.com",
    );
  });

  it("retry de vínculo pendente resolve profile que passou a ser conhecido", async () => {
    const resolvedLink = { ...LINK_ROW, linked_user_id: "placeholder1" };
    adminRows.member_email_links = [LINK_ROW];
    adminRows.profiles = [{
          id: "placeholder1",
          first_name: null,
          email: "extra@exemplo.com",
          activated_at: null,
    }];
    adminRpcResults.write_member_email_link_with_identity_proof = { data: resolvedLink };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "linked",
      link: resolvedLink,
      access: "pending",
    });
    expect(
      rpcArgs("write_member_email_link_with_identity_proof"),
    ).toMatchObject({
      p_existing_link_id: "link1",
      p_expected_linked_user_id: null,
      p_linked_user_id: "placeholder1",
      p_expected_snapshot_version: null,
    });
    expect(hoisted.reconcileClerkEmailOwner).toHaveBeenCalledWith(
      "extra@exemplo.com",
    );
  });

  it("vínculo antigo perde dono Clerk → limpa linked_user_id por CAS", async () => {
    const staleLink = { ...LINK_ROW, linked_user_id: "stale-owner" };
    const pendingLink = { ...LINK_ROW, linked_user_id: null };
    adminRows.member_email_links = [staleLink];
    adminRows.profiles = [{
          id: "target1",
          first_name: "Target",
          email: "extra@exemplo.com",
          activated_at: "2026-01-01",
    }];
    adminRpcResults.write_member_email_link_with_identity_proof = { data: pendingLink };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "linked",
      link: pendingLink,
      access: "pending",
    });
    expect(
      rpcArgs("write_member_email_link_with_identity_proof"),
    ).toMatchObject({
      p_existing_link_id: "link1",
      p_expected_linked_user_id: "stale-owner",
      p_linked_user_id: null,
      p_expected_snapshot_version: null,
    });
  });

  it("CAS sem linha → informa alteração concorrente", async () => {
    adminRows.member_email_links = [LINK_ROW];
    adminRows.profiles = [{
          id: "placeholder1",
          first_name: null,
          email: "extra@exemplo.com",
          activated_at: null,
    }];
    adminRpcResults.write_member_email_link_with_identity_proof = { data: [] };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "O vínculo foi alterado por outra operação.",
    });
  });

  it("CAS que viola identidade terminal → pede nova revisão da unificação", async () => {
    adminRows.member_email_links = [LINK_ROW];
    adminRows.profiles = [{
          id: "placeholder1",
          first_name: null,
          email: "extra@exemplo.com",
          activated_at: null,
    }];
    adminRpcResults.write_member_email_link_with_identity_proof = { error: { message: "check", code: "23514" } };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error:
        "A identidade do vínculo mudou. Tente novamente para revisar a unificação.",
    });
  });

  it("e-mail sem conta → insert com linked_user_id NULL e acesso pendente", async () => {
    const link = await loadLink();
    const r = await link("p1", "target1", "extra@exemplo.com");
    expect(r.status).toBe("linked");
    if (r.status !== "linked") throw new Error("vínculo ausente");
    expect(r.link.linked_user_id).toBeNull();
    expect(r.access).toBe("pending");
    expect(rpcArgs("write_member_email_link_with_identity_proof")).toEqual({
      p_project_id: "p1",
      p_member_user_id: "target1",
      p_email: "extra@exemplo.com",
      p_linked_user_id: null,
      p_created_by: "userCoord",
      p_existing_link_id: null,
      p_expected_linked_user_id: null,
      p_expected_snapshot_version: null,
    });
  });

  it("fecha a corrida quando o webhook resolve a posse antes do insert pendente", async () => {
    const resolvedLink = { ...LINK_ROW, linked_user_id: "late-owner" };
    hoisted.reconcileClerkEmailOwner
      .mockResolvedValueOnce({ status: "unowned" })
      .mockImplementationOnce(async () => {
        adminRows.member_email_links = [resolvedLink];
        return { status: "resolved", userId: "late-owner", snapshotVersion: 120 };
      });
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "linked",
      link: resolvedLink,
      access: "ready",
    });
    expect(hoisted.reconcileClerkEmailOwner).toHaveBeenCalledTimes(2);
  });

  it("insert concorrente duplicado → retorna erro de vínculo existente", async () => {
    adminRpcResults.write_member_email_link_with_identity_proof = { error: { message: "duplicate", code: "23505" } };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "Este e-mail já está vinculado a um membro do projeto.",
    });
  });

  it("e-mail de pré-registro do próprio membro → erro sem insert", async () => {
    adminRows.profiles = [{ id: "target1", first_name: null, email: "eu@x.com", activated_at: null }];
    const link = await loadLink();
    const r = await link("p1", "target1", "eu@x.com");
    expect(r).toEqual({
      status: "error",
      error: "Este já é o e-mail de pré-registro deste membro.",
    });
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
    expectNoWriteRpc("write_member_email_link_with_identity_proof");
  });
});

describe("unlinkMemberEmail", () => {
  it("usa o client da sessão para aplicar o RLS do coordenador", async () => {
    serverRows = { member_email_links: [{ id: "link1", project_id: "p1" }] };
    const { unlinkMemberEmail } = await import("@/actions/members");

    expect(await unlinkMemberEmail("p1", "link1")).toEqual({});
    expect(adminCreateCalls).toBe(0);
    expect(writeCalls).toContainEqual({
      table: "member_email_links",
      op: "delete",
      payload: null,
      filters: [["eq", "id", "link1"], ["eq", "project_id", "p1"]],
    });
  });
});

describe("unifyMembers", () => {
  const NO_CONFLICTS = {
    assignments_to_migrate: 2,
    docs_with_both_responses: 1,
    review_conflicts: 0,
    arbitration_conflicts: 0,
    comparison_conflicts: 0,
  };

  function setValidUnificationSource(
    email: string,
    activatedAt: string | null,
  ) {
    adminRows = {
      profiles: [{ id: "source", email, activated_at: activatedAt }],
    };
    adminRpcResults.preview_project_member_unification = {
      data: NO_CONFLICTS,
    };
  }

  async function runUnification(
    email: string,
    sourceUserId = "source",
    targetUserId = "target",
  ) {
    const { unifyMembers } = await import("@/actions/members");
    return unifyMembers("p1", sourceUserId, targetUserId, email);
  }

  it("revalida o preview, prova o e-mail e executa a RPC com o ator", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "source",
      snapshotVersion: 110,
    });
    adminRows = {
      profiles: [{ id: "source", email: "Source@Example.com", activated_at: "2026-01-01" }],
    };
    adminRpcResults = {
      preview_project_member_unification: { data: NO_CONFLICTS },
      unify_project_members: { data: null },
    };
    const { unifyMembers } = await import("@/actions/members");

    expect(
      await unifyMembers("p1", "source", "target", " source@example.com "),
    ).toEqual({});
    expect(hoisted.reconcileClerkEmailOwner).toHaveBeenCalledWith(
      "source@example.com",
    );
    expect(rpcArgs("unify_project_members")).toEqual({
      p_project_id: "p1",
      p_source_user_id: "source",
      p_target_user_id: "target",
      p_linked_user_id: "source",
      p_link_email: "source@example.com",
      p_acting_user_id: "userCoord",
      p_expected_snapshot_version: 110,
    });
    expect(hoisted.revalidatePath).toHaveBeenCalledWith(
      "/projects/p1/analyze/assignments",
    );
  });

  it("pré-registro pendente sem conta Clerk pode ser unificado pelo próprio e-mail", async () => {
    adminRows = {
      profiles: [{ id: "source", email: "pending@example.com", activated_at: null }],
    };
    adminRpcResults = {
      preview_project_member_unification: { data: NO_CONFLICTS },
      unify_project_members: { data: null },
    };
    const { unifyMembers } = await import("@/actions/members");

    expect(
      await unifyMembers("p1", "source", "target", "pending@example.com"),
    ).toEqual({});
    expect(rpcArgs("unify_project_members").p_linked_user_id).toBe("source");
    expect(hoisted.reconcileClerkEmailOwner).toHaveBeenCalledWith(
      "pending@example.com",
    );
  });

  it("source pendente já mapeado e sem dono exato não pode ser unificado", async () => {
    adminRows = {
      profiles: [{ id: "source", email: "pending@example.com", activated_at: null }],
      clerk_user_mapping: [{ supabase_user_id: "source" }],
    };
    adminRpcResults.preview_project_member_unification = {
      data: NO_CONFLICTS,
    };

    expect(await runUnification("pending@example.com")).toEqual({
      error:
        "O e-mail não corresponde a um pré-registro pendente do membro de origem.",
    });
    expect(rpcCalls.some((call) => call.fn === "unify_project_members")).toBe(
      false,
    );
  });

  it("profile de origem ausente → falha antes de provar identidade", async () => {
    adminRows = { profiles: [] };
    adminRpcResults.preview_project_member_unification = {
      data: NO_CONFLICTS,
    };
    const { unifyMembers } = await import("@/actions/members");

    expect(
      await unifyMembers("p1", "source", "target", "source@example.com"),
    ).toEqual({ error: "O membro de origem não possui profile." });
    expect(hoisted.reconcileClerkEmailOwner).not.toHaveBeenCalled();
  });

  it("preview ausente → trata membros como indisponíveis", async () => {
    adminRows = {
      profiles: [{ id: "source", email: "source@example.com", activated_at: null }],
    };
    adminRpcResults.preview_project_member_unification = { data: null };
    const { unifyMembers } = await import("@/actions/members");

    expect(
      await unifyMembers("p1", "source", "target", "source@example.com"),
    ).toEqual({
      error: "Os dois membros não estão mais disponíveis para unificação.",
    });
    expect(hoisted.reconcileClerkEmailOwner).not.toHaveBeenCalled();
  });

  it.each(["arbitration_conflicts", "comparison_conflicts"] as const)(
    "conflito em %s bloqueia a unificação",
    async (conflictField) => {
      adminRows = {
        profiles: [{ id: "source", email: "source@example.com", activated_at: null }],
      };
      adminRpcResults.preview_project_member_unification = {
        data: { ...NO_CONFLICTS, [conflictField]: 1 },
      };
      const { unifyMembers } = await import("@/actions/members");

      expect(
        await unifyMembers("p1", "source", "target", "source@example.com"),
      ).toEqual({
        error: "A unificação possui conflitos que precisam ser resolvidos.",
      });
      expect(hoisted.reconcileClerkEmailOwner).not.toHaveBeenCalled();
    },
  );

  it("falha no lookup Clerk → não executa a unificação", async () => {
    hoisted.reconcileClerkEmailOwner.mockRejectedValue(
      new Error("Clerk indisponível"),
    );
    setValidUnificationSource("source@example.com", null);

    expect(await runUnification("source@example.com")).toEqual({
      error:
        "Não foi possível verificar a posse atual do e-mail. Tente novamente.",
    });
    expect(rpcCalls.some((call) => call.fn === "unify_project_members")).toBe(
      false,
    );
  });

  it("profile ativo sem dono Clerk atual não prova o e-mail", async () => {
    setValidUnificationSource("source@example.com", "2026-01-01");

    expect(await runUnification("source@example.com")).toEqual({
      error:
        "O e-mail não corresponde a um pré-registro pendente do membro de origem.",
    });
  });

  it("pré-registro pendente com outro e-mail não prova a origem", async () => {
    setValidUnificationSource("other@example.com", null);

    expect(await runUnification("source@example.com")).toEqual({
      error:
        "O e-mail não corresponde a um pré-registro pendente do membro de origem.",
    });
  });

  it("dono Clerk atual substitui o placeholder pendente durante a unificação", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "owner-account",
      snapshotVersion: 111,
    });
    adminRows = {
      profiles: [{ id: "placeholder", email: "pending@example.com", activated_at: null }],
    };
    adminRpcResults = {
      preview_project_member_unification: { data: NO_CONFLICTS },
      unify_project_members: { data: null },
    };
    const { unifyMembers } = await import("@/actions/members");

    expect(
      await unifyMembers("p1", "placeholder", "target", "pending@example.com"),
    ).toEqual({});
    expect(rpcArgs("unify_project_members")).toMatchObject({
      p_source_user_id: "placeholder",
      p_target_user_id: "target",
      p_linked_user_id: "owner-account",
      p_link_email: "pending@example.com",
    });
  });

  it("posse alterada durante a operação não degrada para placeholder", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({ status: "changed" });
    setValidUnificationSource("pending@example.com", null);

    expect(await runUnification("pending@example.com")).toEqual({
      error: "A posse verificada do e-mail mudou. Tente novamente.",
    });
    expect(rpcCalls.some((call) => call.fn === "unify_project_members")).toBe(
      false,
    );
  });

  it("dono Clerk reconciliado como target → recusa auto-alias", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "target",
      snapshotVersion: 112,
    });
    setValidUnificationSource("pending@example.com", null);

    expect(await runUnification("pending@example.com")).toEqual({
      error: "A conta verificada já pertence ao membro de destino.",
    });
    expect(rpcCalls.some((call) => call.fn === "unify_project_members")).toBe(
      false,
    );
  });

  it("recusa e-mail verificado reconciliado para uma terceira identidade", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "third-party",
      snapshotVersion: 113,
    });
    adminRows = {
      profiles: [{ id: "source", email: "administrative@example.com",
          activated_at: "2026-01-01", }],
    };
    adminRpcResults.preview_project_member_unification = {
      data: NO_CONFLICTS,
    };
    const { unifyMembers } = await import("@/actions/members");

    expect(
      await unifyMembers("p1", "source", "target", "alias@example.com"),
    ).toEqual({
      error: "O e-mail verificado não pertence ao membro de origem.",
    });
    expect(hoisted.reconcileClerkEmailOwner).toHaveBeenCalledWith(
      "alias@example.com",
    );
    expect(rpcCalls.some((call) => call.fn === "unify_project_members")).toBe(
      false,
    );
  });

  it("profile ativo com e-mail histórico não prova posse contra o dono atual", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "new-owner",
      snapshotVersion: 114,
    });
    adminRows = {
      profiles: [{ id: "source", email: "reassigned@example.com", activated_at: "2026-01-01" }],
    };
    adminRpcResults.preview_project_member_unification = {
      data: NO_CONFLICTS,
    };
    const { unifyMembers } = await import("@/actions/members");

    expect(
      await unifyMembers("p1", "source", "target", "reassigned@example.com"),
    ).toEqual({
      error: "O e-mail verificado não pertence ao membro de origem.",
    });
    expect(rpcCalls.some((call) => call.fn === "unify_project_members")).toBe(
      false,
    );
  });

  it("não executa quando a releitura do preview encontra conflito", async () => {
    adminRows = {
      profiles: [{ id: "source", email: "source@example.com", activated_at: null }],
    };
    adminRpcResults.preview_project_member_unification = {
      data: { ...NO_CONFLICTS, review_conflicts: 1 },
    };
    const { unifyMembers } = await import("@/actions/members");

    expect(
      await unifyMembers("p1", "source", "target", "source@example.com"),
    ).toEqual({
      error: "A unificação possui conflitos que precisam ser resolvidos.",
    });
    expect(rpcCalls.some((call) => call.fn === "unify_project_members")).toBe(
      false,
    );
  });

  it("propaga falha da RPC sem revalidar caches", async () => {
    adminRows = {
      profiles: [{ id: "source", email: "source@example.com", activated_at: null }],
    };
    adminRpcResults = {
      preview_project_member_unification: { data: NO_CONFLICTS },
      unify_project_members: { error: { message: "conflito concorrente" } },
    };
    const { unifyMembers } = await import("@/actions/members");

    expect(
      await unifyMembers("p1", "source", "target", "source@example.com"),
    ).toEqual({ error: "conflito concorrente" });
    expect(hoisted.revalidatePath).not.toHaveBeenCalled();
  });
});
