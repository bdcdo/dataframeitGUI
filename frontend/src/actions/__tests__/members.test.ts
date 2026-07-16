import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  makeSupabaseMock,
  type FilterCall,
  type RpcCall,
  type TableResult,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

let writeCalls: WriteCall[];
let filterCalls: FilterCall[];
let rpcCalls: RpcCall[];
const updateAuthUserById = vi.fn<
  (
    userId: string,
    attributes: { email: string; email_confirm: true },
  ) => Promise<{
    data: { user: { id: string } | null };
    error: { message: string } | null;
  }>
>(async (userId) => ({ data: { user: { id: userId } }, error: null }));

function makeClient(
  updateError?: { message: string },
  tableResults?: TableResults,
  rpcResults?: Record<string, TableResult | TableResult[]>,
) {
  const identityRpcResults: Record<string, TableResult | TableResult[]> = {
    ...(rpcResults ?? {}),
  };
  if (tableResults?.project_members) {
    identityRpcResults.add_project_member_with_identity_proof =
      tableResults.project_members;
  }
  if (tableResults?.member_email_links) {
    identityRpcResults.write_member_email_link_with_identity_proof =
      tableResults.member_email_links;
  }
  const client = makeSupabaseMock({
    tableResults: {
      clerk_user_mapping: { data: null },
      ...(tableResults ?? {}),
    },
    defaultResult: updateError
      ? { data: null, error: updateError }
      : { data: { project_id: "p-derived", user_id: "userMemberX" } },
    writeCalls,
    filterCalls,
    rpcCalls,
    rpcResults: identityRpcResults,
  });
  return {
    ...client,
    auth: { admin: { updateUserById: updateAuthUserById } },
  };
}

let clientError: { message: string } | undefined;
let serverTableResults: TableResults | undefined;
let adminTableResults: TableResults | undefined;
let serverRpcResults: Record<string, TableResult | TableResult[]>;
let adminRpcResults: Record<string, TableResult | TableResult[]>;
let adminCreateCalls: number;

const hoisted = vi.hoisted(() => ({
  revalidatePath: vi.fn<(path: string) => void>(),
  revalidateTag: vi.fn<(tag: string, profile: unknown) => void>(),
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
  revalidateTag: hoisted.revalidateTag,
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
  createSupabaseServer: async () =>
    makeClient(clientError, serverTableResults, serverRpcResults),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => {
    adminCreateCalls++;
    return makeClient(clientError, adminTableResults, adminRpcResults);
  },
}));
vi.mock("@/actions/field-reviews", () => ({
  retryPendingArbitrations: hoisted.retry,
}));
vi.mock("@/actions/comparisons", () => ({
  retryPendingComparisons: hoisted.retryComparisons,
}));
beforeEach(() => {
  writeCalls = [];
  filterCalls = [];
  rpcCalls = [];
  clientError = undefined;
  serverTableResults = undefined;
  adminTableResults = undefined;
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
  hoisted.revalidateTag.mockReset();
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

function rpcArgs(fn: string): Record<string, unknown> {
  const call = rpcCalls.find((entry) => entry.fn === fn);
  return (call?.args as Record<string, unknown>) ?? {};
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
    expect(hoisted.revalidateTag).toHaveBeenCalledWith(
      "project-p-canonical-members",
      expect.anything(),
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
    expect(r.error).toBe("RLS bloqueou");
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

    expect(await set("member-1", false)).toEqual({ error: "falha atômica" });
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
    serverTableResults = {
      project_members: { data: { project_id: "p-canonical" } },
    };
    const change = await loadChangeRole();
    const r = await change("member-1", "coordenador");

    expect(r?.error).toBeUndefined();
    expect(hoisted.revalidatePath).toHaveBeenCalledWith(
      "/projects/p-canonical",
    );
  });

  it("linha ausente → erro fail-closed", async () => {
    serverTableResults = { project_members: { data: null } };
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
    });
  });

  it("UPDATE falha → retorna error", async () => {
    clientError = { message: "RLS bloqueou" };
    const set = await loadSetResolve();
    const r = await set("member1", true);
    expect(r.error).toBe("RLS bloqueou");
  });

  it("linha ausente → erro fail-closed", async () => {
    serverTableResults = { project_members: { data: null } };
    const set = await loadSetResolve();

    expect(await set("missing", true)).toEqual({
      error: "Membro não encontrado ou sem permissão.",
    });
  });
});

async function loadAdd() {
  return (await import("@/actions/members")).addMember;
}

describe("addMember (pré-registro, spec 002)", () => {
  function setAddCurrentOwnerContext({
    linkedOwner,
    projectMembers,
  }: {
    linkedOwner: TableResult;
    projectMembers: TableResult | TableResult[];
  }) {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "ownerUid",
      snapshotVersion: 101,
    });
    adminTableResults = {
      profiles: [{ data: null }, { data: { id: "ownerUid" } }],
      member_email_links: [{ data: null }, linkedOwner],
      project_members: projectMembers,
    };
  }

  it("e-mail inválido → erro sem tocar no banco nem pré-registrar", async () => {
    const add = await loadAdd();
    const r = await add("p1", "sem-arroba", "pesquisador");
    expect(r.error).toBe("E-mail inválido.");
    expect(hoisted.preregister).not.toHaveBeenCalled();
    expect(writeCalls).toEqual([]);
  });

  it("normaliza e-mail (trim + lowercase) antes de pré-registrar", async () => {
    adminTableResults = {
      profiles: { data: null },
      member_email_links: { data: null },
      project_members: { data: null },
    };
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
    adminTableResults = {
      profiles: [
        { data: { id: "legacyUid", activated_at: "2026-01-01" } },
        { data: { id: "ownerUid" } },
      ],
      member_email_links: [{ data: null }, { data: null }],
      project_members: [{ data: null }, { data: null }],
    };
    const add = await loadAdd();
    const r = await add("p1", "ja-tem@conta.com", "pesquisador");
    expect(r.error).toBeUndefined();
    expect(r.pending).toBe(false);
    expect(hoisted.preregister).not.toHaveBeenCalled();
    expect(hoisted.reconcileClerkEmailOwner).toHaveBeenCalledWith(
      "ja-tem@conta.com",
    );
    expect(filterCalls).not.toContainEqual({
      table: "project_members",
      method: "eq",
      column: "user_id",
      value: "legacyUid",
    });
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
    adminTableResults = {
      profiles: [
        { data: { id: "legacyUid", activated_at: "2026-01-01" } },
        { data: { id: "legacyUid" } },
      ],
      member_email_links: [{ data: null }, { data: null }],
      project_members: { data: { id: "membership1" } },
    };
    const add = await loadAdd();

    expect(await add("p1", "still-owned@conta.com", "pesquisador")).toEqual({
      error: "Usuário já é membro deste projeto.",
    });
    expect(writeCalls.filter((call) => call.op === "insert")).toEqual([]);
  });

  it("profile existente mas ainda pendente (pré-registrado em outro projeto) → pending true", async () => {
    adminTableResults = {
      profiles: { data: { id: "placeholderUid2", activated_at: null } },
      member_email_links: { data: null },
      project_members: [{ data: null }, { data: null }],
      clerk_user_mapping: { data: null },
    };
    const add = await loadAdd();
    const r = await add("p1", "pendente@conta.com", "pesquisador");
    expect(r.error).toBeUndefined();
    expect(r.pending).toBe(true);
    expect(hoisted.preregister).not.toHaveBeenCalled();
  });

  it("profile pendente já mapeado e sem dono exato não vira membership", async () => {
    adminTableResults = {
      profiles: { data: { id: "claimedUid", activated_at: null } },
      member_email_links: { data: null },
      project_members: { data: null },
      clerk_user_mapping: { data: { supabase_user_id: "claimedUid" } },
    };
    const add = await loadAdd();

    expect(await add("p1", "antigo@exemplo.com", "pesquisador")).toEqual({
      error:
        "Este pré-registro já pertence a outra conta Clerk e não pode ser reutilizado.",
    });
    expect(hoisted.preregister).not.toHaveBeenCalled();
    expect(
      writeCalls.some(
        (call) => call.table === "project_members" && call.op === "insert",
      ),
    ).toBe(false);
  });

  it("profile pendente mapeado só segue quando o dono exato resolve para o mesmo UID", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "claimedUid",
      snapshotVersion: 104,
    });
    adminTableResults = {
      profiles: [
        { data: { id: "claimedUid", activated_at: null } },
        { data: { id: "claimedUid" } },
      ],
      member_email_links: [{ data: null }, { data: null }],
      project_members: [{ data: null }, { data: null }],
      clerk_user_mapping: { data: { supabase_user_id: "claimedUid" } },
    };
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
    adminTableResults = {
      profiles: { data: { id: "existingUid", activated_at: "2026-01-01" } },
      member_email_links: { data: null },
      project_members: { data: null },
    };
    const add = await loadAdd();

    expect(await add("p1", "ja-tem@conta.com", "pesquisador")).toEqual({
      error:
        "Não foi possível confirmar que a conta ativa ainda possui este e-mail.",
    });
    expect(writeCalls.filter((call) => call.op === "insert")).toEqual([]);
  });

  it("e-mail vinculado a outro membro do projeto → erro orientando a desvincular", async () => {
    adminTableResults = {
      profiles: { data: { id: "srcUid", activated_at: "2026-01-01" } },
      member_email_links: { data: { member_user_id: "target1" } },
    };
    const add = await loadAdd();
    const r = await add("p1", "vinculado@conta.com", "pesquisador");
    expect(r.error).toContain("vinculado a outro membro");
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
  });

  it("falha no lookup de posse Clerk → fail-closed após validações locais", async () => {
    hoisted.reconcileClerkEmailOwner.mockRejectedValue(
      new Error("Clerk indisponível"),
    );
    adminTableResults = {
      profiles: { data: null },
      member_email_links: { data: null },
    };
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error:
        "Não foi possível verificar a posse atual do e-mail. Tente novamente.",
    });
    expect(adminCreateCalls).toBe(1);
    expect(writeCalls).toEqual([]);
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
    adminTableResults = {
      profiles: { data: null },
      member_email_links: { data: null },
    };
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error: "Mais de uma conta Clerk possui o e-mail verificado",
    });
    expect(writeCalls).toEqual([]);
  });

  it("falha na validação local → não consulta o Clerk", async () => {
    adminTableResults = {
      profiles: { error: { message: "profiles indisponível" } },
      member_email_links: { data: null },
    };
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error: "profiles indisponível",
    });
    expect(hoisted.reconcileClerkEmailOwner).not.toHaveBeenCalled();
    expect(writeCalls).toEqual([]);
  });

  it("posse alterada durante a operação não cria membership pendente", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({ status: "changed" });
    adminTableResults = {
      profiles: { data: null },
      member_email_links: { data: null },
    };
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error: "A posse verificada do e-mail mudou. Tente novamente.",
    });
    expect(hoisted.preregister).not.toHaveBeenCalled();
    expect(writeCalls).toEqual([]);
  });

  it("dono Clerk reconciliado sem profile Supabase → falha fechada", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "ownerUid",
      snapshotVersion: 105,
    });
    adminTableResults = {
      profiles: [{ data: null }, { data: null }],
      member_email_links: [{ data: null }, { data: null }],
      project_members: { data: null },
    };
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error: "A conta verificada não possui profile Supabase.",
    });
    expect(writeCalls.filter((call) => call.op === "insert")).toEqual([]);
  });

  it("erro genérico no insert é propagado sem revalidar cache", async () => {
    adminTableResults = {
      profiles: { data: null },
      member_email_links: { data: null },
      project_members: { error: { message: "insert indisponível" } },
    };
    const add = await loadAdd();

    expect(await add("p1", "novo@exemplo.com", "pesquisador")).toEqual({
      error: "insert indisponível",
    });
    expect(hoisted.revalidatePath).not.toHaveBeenCalled();
    expect(hoisted.revalidateTag).not.toHaveBeenCalled();
  });

  it("membership do profile administrativo bloqueia duplicação antes da reconciliação", async () => {
    adminTableResults = {
      profiles: { data: { id: "existingUid", activated_at: null } },
      member_email_links: { data: null },
      project_members: { data: { id: "membership1" } },
    };
    const add = await loadAdd();

    expect(await add("p1", "ja-tem@conta.com", "pesquisador")).toEqual({
      error: "Usuário já é membro deste projeto.",
    });
    expect(hoisted.reconcileClerkEmailOwner).not.toHaveBeenCalled();
  });

  it("alias da conta por outro e-mail bloqueia uma membership terminal inválida", async () => {
    setAddCurrentOwnerContext({
      linkedOwner: { data: { member_user_id: "canonicalMember" } },
      projectMembers: { data: null },
    });
    const add = await loadAdd();

    expect(await add("p1", "primary@conta.com", "pesquisador")).toEqual({
      error:
        "Esta conta já está vinculada a um membro do projeto. Desvincule-a antes de adicioná-la como membro próprio.",
    });
    expect(filterCalls).toContainEqual({
      table: "member_email_links",
      method: "eq",
      column: "linked_user_id",
      value: "ownerUid",
    });
    expect(writeCalls.filter((call) => call.op === "insert")).toEqual([]);
  });

  it("insert concorrente duplicado (23505) → mensagem de já membro", async () => {
    setAddCurrentOwnerContext({
      linkedOwner: { data: null },
      projectMembers: [
        { data: null },
        { error: { message: "duplicate key", code: "23505" } },
      ],
    });
    const add = await loadAdd();

    expect(await add("p1", "ja-tem@conta.com", "pesquisador")).toEqual({
      error: "Usuário já é membro deste projeto.",
    });
  });

  it("falha no pré-registro → erro amigável, sem insert em project_members", async () => {
    adminTableResults = {
      profiles: { data: null },
      member_email_links: { data: null },
    };
    hoisted.preregister.mockRejectedValueOnce(new Error("kaboom"));
    const add = await loadAdd();
    const r = await add("p1", "novo@exemplo.com", "pesquisador");
    expect(r.error).toBe("Erro ao pré-registrar: kaboom");
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
  });
});

async function loadUpdatePendingEmail() {
  return (await import("@/actions/members")).updatePendingMemberEmail;
}

describe("updatePendingMemberEmail — lookups fail-closed", () => {
  it("delega a troca canônica ao Auth Admin sem duplicar a escrita do profile", async () => {
    adminTableResults = {
      project_members: [{ data: { id: "pm1" } }, { count: 2 }],
      profiles: [
        { data: { id: "member1", activated_at: null } },
        { data: null },
      ],
      member_email_links: { data: null },
      clerk_user_mapping: { data: null },
    };
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
    adminTableResults = {
      project_members: { data: { id: "pm1" } },
      profiles: [
        { data: { id: "member1", activated_at: null } },
        { data: null },
      ],
      member_email_links: { data: null },
      clerk_user_mapping: { data: null },
    };
    updateAuthUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "placeholder reclamado" },
    });
    const update = await loadUpdatePendingEmail();

    await expect(update("p1", "member1", "novo@exemplo.com")).resolves.toEqual({
      error: "Erro ao atualizar e-mail: placeholder reclamado",
    });
    expect(hoisted.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "membership",
      results: {
        project_members: { error: { message: "membership indisponível" } },
        profiles: [
          { data: { id: "member1", activated_at: null } },
          { data: null },
        ],
        member_email_links: { data: null },
      },
      message: "membership indisponível",
    },
    {
      label: "perfil-alvo",
      results: {
        project_members: { data: { id: "pm1" } },
        profiles: [
          { error: { message: "perfil-alvo indisponível" } },
          { data: null },
        ],
        member_email_links: { data: null },
      },
      message: "perfil-alvo indisponível",
    },
    {
      label: "dono do e-mail",
      results: {
        project_members: { data: { id: "pm1" } },
        profiles: [
          { data: { id: "member1", activated_at: null } },
          { error: { message: "dono indisponível" } },
        ],
        member_email_links: { data: null },
      },
      message: "dono indisponível",
    },
    {
      label: "vínculo do e-mail",
      results: {
        project_members: { data: { id: "pm1" } },
        profiles: [
          { data: { id: "member1", activated_at: null } },
          { data: null },
        ],
        member_email_links: { error: { message: "vínculo indisponível" } },
      },
      message: "vínculo indisponível",
    },
  ])(
    "falha em $label interrompe antes de mutações",
    async ({ results, message }) => {
      adminTableResults = results;
      const update = await loadUpdatePendingEmail();

      expect(await update("p1", "member1", "novo@exemplo.com")).toEqual({
        error: message,
      });
      expect(writeCalls).toEqual([]);
    },
  );

  it("profile pendente já mapeado não pode ter o e-mail alterado", async () => {
    adminTableResults = {
      project_members: { data: { id: "pm1" } },
      profiles: [
        { data: { id: "member1", activated_at: null } },
        { data: null },
      ],
      member_email_links: { data: null },
      clerk_user_mapping: { data: { clerk_user_id: "clerk_1" } },
    };
    const update = await loadUpdatePendingEmail();

    expect(await update("p1", "member1", "novo@exemplo.com")).toEqual({
      error:
        "Este membro já está vinculado a uma conta Clerk e não pode ter o e-mail de pré-registro alterado.",
    });
    expect(writeCalls).toEqual([]);
  });

  it("falha ao verificar mapping interrompe antes de alterar auth/profile", async () => {
    adminTableResults = {
      project_members: { data: { id: "pm1" } },
      profiles: [
        { data: { id: "member1", activated_at: null } },
        { data: null },
      ],
      member_email_links: { data: null },
      clerk_user_mapping: { error: { message: "mapping indisponível" } },
    };
    const update = await loadUpdatePendingEmail();

    expect(await update("p1", "member1", "novo@exemplo.com")).toEqual({
      error: "mapping indisponível",
    });
    expect(writeCalls).toEqual([]);
  });
});

async function loadLink() {
  return (await import("@/actions/members")).linkMemberEmail;
}

describe("linkMemberEmail (vínculo de e-mails, spec 002 US2)", () => {
  const LINK_ROW = {
    id: "link1",
    project_id: "p1",
    member_user_id: "target1",
    email: "extra@exemplo.com",
    linked_user_id: null,
    created_by: "userCoord",
    created_at: "2026-06-11T00:00:00Z",
  };

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
  const EMPTY_PREVIEW = { data: null };

  function setEmptyTargetLinkContext() {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: { data: null },
      profiles: { data: null },
    };
  }

  function setCurrentOwnerLinkContext({
    ownerUserId = "acc1",
    projectMembers = [
      { data: { role: "pesquisador" } },
      { data: { role: "pesquisador" } },
    ],
    links = [{ data: null }, { data: null }],
    profiles = [
      { data: EMAIL_PROFILE },
      { data: OWNER_PROFILE },
      { data: EMAIL_PROFILE },
    ],
  }: {
    ownerUserId?: string;
    projectMembers?: TableResult[];
    links?: TableResult[];
    profiles?: TableResult[];
  } = {}) {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: ownerUserId,
      snapshotVersion: 106,
    });
    adminTableResults = {
      project_members: projectMembers,
      member_email_links: links,
      profiles,
    };
    adminRpcResults.preview_project_member_unification = EMPTY_PREVIEW;
  }

  it("e-mail já vinculado a outro membro → valida antes de reconciliar", async () => {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: { data: { id: "l0", member_user_id: "outro1" } },
      profiles: [
        { data: null },
        { data: { id: "outro1", first_name: "Ana", email: "ana@x.com" } },
      ],
    };
    const link = await loadLink();
    const r = await link("p1", "target1", "extra@exemplo.com");
    expect(r).toEqual({
      status: "error",
      error: "Este e-mail já está vinculado a Ana neste projeto.",
    });
    expect(hoisted.reconcileClerkEmailOwner).not.toHaveBeenCalled();
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
  });

  it("target inexistente → valida antes de reconciliar", async () => {
    adminTableResults = {
      project_members: { data: null },
      member_email_links: { data: null },
      profiles: { data: null },
    };
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
    setEmptyTargetLinkContext();
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error:
        "Não foi possível verificar a posse atual do e-mail. Tente novamente.",
    });
    expect(writeCalls).toEqual([]);
  });

  it("releitura após reconciliação perde o target → falha sem persistir", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "acc1",
      snapshotVersion: 107,
    });
    adminTableResults = {
      project_members: [{ data: { role: "pesquisador" } }, { data: null }],
      member_email_links: [{ data: null }, { data: null }],
      profiles: [{ data: null }, { data: OWNER_PROFILE }, { data: null }],
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "Membro não encontrado neste projeto.",
    });
    expect(writeCalls).toEqual([]);
  });

  it("dono Clerk reconciliado sem profile Supabase → falha fechada", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "acc1",
      snapshotVersion: 108,
    });
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: { data: null },
      profiles: [{ data: null }, { data: null }],
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "A conta verificada não possui profile Supabase.",
    });
    expect(writeCalls).toEqual([]);
  });

  it("e-mail verificado da própria conta alvo → não cria auto-vínculo", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({
      status: "resolved",
      userId: "target1",
      snapshotVersion: 109,
    });
    const targetProfile = { ...OWNER_PROFILE, id: "target1" };
    adminTableResults = {
      project_members: [
        { data: { role: "pesquisador" } },
        { data: { role: "pesquisador" } },
      ],
      member_email_links: [{ data: null }, { data: null }],
      profiles: [
        { data: targetProfile },
        { data: targetProfile },
        { data: targetProfile },
      ],
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "Este e-mail já pertence à conta deste membro.",
    });
    expect(writeCalls).toEqual([]);
  });

  it("profile administrativo que é membro → preview preserva linkEmail", async () => {
    adminTableResults = {
      project_members: { data: { role: "coordenador" } },
      member_email_links: { data: null },
      profiles: {
        data: {
          id: "src1",
          first_name: "Beto",
          email: "beto@x.com",
          activated_at: null,
        },
      },
    };
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
  });

  it("falha na RPC de preview → não persiste vínculo", async () => {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: { data: null },
      profiles: { data: EMAIL_PROFILE },
    };
    adminRpcResults.preview_project_member_unification = {
      error: { message: "preview indisponível" },
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "preview indisponível",
    });
    expect(writeCalls).toEqual([]);
  });

  it("dono atual e placeholder com o mesmo id geram um único preview", async () => {
    const pendingOwner = { ...OWNER_PROFILE, activated_at: null };
    setCurrentOwnerLinkContext({
      profiles: [
        { data: pendingOwner },
        { data: pendingOwner },
        { data: pendingOwner },
      ],
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
      links: [
        { data: null },
        { data: null },
        { data: { ...LINK_ROW, linked_user_id: "acc1" } },
      ],
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
      links: [{ data: staleLink }, { data: staleLink }, { data: resolvedLink }],
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
      links: [
        { data: null },
        { data: null },
        { data: { ...LINK_ROW, linked_user_id: "acc1" } },
      ],
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
      profiles: [
        { data: { ...EMAIL_PROFILE, activated_at: null } },
        { data: OWNER_PROFILE },
        { data: { ...EMAIL_PROFILE, activated_at: null } },
      ],
    });
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
  });

  it("profile ativo sem dono Clerk confirmado → falha fechada", async () => {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: { data: null },
      profiles: { data: EMAIL_PROFILE },
    };
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
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: { data: null },
      profiles: {
        data: {
          id: "claimedUid",
          first_name: null,
          email: "extra@exemplo.com",
          activated_at: null,
        },
      },
      clerk_user_mapping: { data: { supabase_user_id: "claimedUid" } },
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error:
        "Este e-mail pertence a uma identidade Clerk diferente e não pode ser reutilizado como pré-registro.",
    });
    expect(writeCalls).toEqual([]);
  });

  it("posse alterada durante a operação não degrada para vínculo pendente", async () => {
    hoisted.reconcileClerkEmailOwner.mockResolvedValue({ status: "changed" });
    setEmptyTargetLinkContext();
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "A posse verificada do e-mail mudou. Tente novamente.",
    });
    expect(writeCalls).toEqual([]);
  });

  it("profile pré-registrado preserva a identidade conhecida como pendente", async () => {
    const knownPendingLink = {
      ...LINK_ROW,
      linked_user_id: "placeholder1",
    };
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: [{ data: null }, { data: knownPendingLink }],
      profiles: {
        data: {
          id: "placeholder1",
          first_name: null,
          email: "extra@exemplo.com",
          activated_at: null,
        },
      },
    };
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
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: [{ data: LINK_ROW }, { data: resolvedLink }],
      profiles: {
        data: {
          id: "placeholder1",
          first_name: null,
          email: "extra@exemplo.com",
          activated_at: null,
        },
      },
    };
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
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: [{ data: staleLink }, { data: pendingLink }],
      profiles: {
        data: {
          id: "target1",
          first_name: "Target",
          email: "extra@exemplo.com",
          activated_at: "2026-01-01",
        },
      },
    };
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
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: [{ data: LINK_ROW }, { data: null }],
      profiles: {
        data: {
          id: "placeholder1",
          first_name: null,
          email: "extra@exemplo.com",
          activated_at: null,
        },
      },
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "O vínculo foi alterado por outra operação.",
    });
  });

  it("CAS que viola identidade terminal → pede nova revisão da unificação", async () => {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: [
        { data: LINK_ROW },
        { error: { message: "check", code: "23514" } },
      ],
      profiles: {
        data: {
          id: "placeholder1",
          first_name: null,
          email: "extra@exemplo.com",
          activated_at: null,
        },
      },
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error:
        "A identidade do vínculo mudou. Tente novamente para revisar a unificação.",
    });
  });

  it("e-mail sem conta → insert com linked_user_id NULL e acesso pendente", async () => {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: [{ data: null }, { data: LINK_ROW }],
      profiles: { data: null },
    };
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
      .mockResolvedValueOnce({
        status: "resolved",
        userId: "late-owner",
        snapshotVersion: 120,
      });
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: [
        { data: null },
        { data: LINK_ROW },
        { data: resolvedLink },
      ],
      profiles: { data: null },
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "linked",
      link: resolvedLink,
      access: "ready",
    });
    expect(hoisted.reconcileClerkEmailOwner).toHaveBeenCalledTimes(2);
  });

  it("insert concorrente duplicado → retorna erro de vínculo existente", async () => {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: [
        { data: null },
        { error: { message: "duplicate", code: "23505" } },
      ],
      profiles: { data: null },
    };
    const link = await loadLink();

    expect(await link("p1", "target1", "extra@exemplo.com")).toEqual({
      status: "error",
      error: "Este e-mail já está vinculado a um membro do projeto.",
    });
  });

  it("e-mail de pré-registro do próprio membro → erro sem insert", async () => {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: { data: null },
      profiles: {
        data: { id: "target1", first_name: null, email: "eu@x.com" },
      },
    };
    const link = await loadLink();
    const r = await link("p1", "target1", "eu@x.com");
    expect(r).toEqual({
      status: "error",
      error: "Este já é o e-mail de pré-registro deste membro.",
    });
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
  });
});

describe("unlinkMemberEmail", () => {
  it("usa o client da sessão para aplicar o RLS do coordenador", async () => {
    serverTableResults = {
      member_email_links: { data: null },
    };
    const { unlinkMemberEmail } = await import("@/actions/members");

    expect(await unlinkMemberEmail("p1", "link1")).toEqual({});
    expect(adminCreateCalls).toBe(0);
    expect(writeCalls).toContainEqual({
      table: "member_email_links",
      op: "delete",
      payload: null,
    });
    expect(filterCalls).toEqual(
      expect.arrayContaining([
        {
          table: "member_email_links",
          method: "eq",
          column: "id",
          value: "link1",
        },
        {
          table: "member_email_links",
          method: "eq",
          column: "project_id",
          value: "p1",
        },
      ]),
    );
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
    adminTableResults = {
      profiles: { data: { email, activated_at: activatedAt } },
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
    adminTableResults = {
      profiles: {
        data: { email: "Source@Example.com", activated_at: "2026-01-01" },
      },
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
    expect(hoisted.revalidateTag).toHaveBeenCalledWith(
      "project-p1-members",
      expect.anything(),
    );
  });

  it("pré-registro pendente sem conta Clerk pode ser unificado pelo próprio e-mail", async () => {
    adminTableResults = {
      profiles: {
        data: { email: "pending@example.com", activated_at: null },
      },
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
    adminTableResults = {
      profiles: {
        data: { email: "pending@example.com", activated_at: null },
      },
      clerk_user_mapping: { data: { supabase_user_id: "source" } },
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
    adminTableResults = { profiles: { data: null } };
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
    adminTableResults = {
      profiles: { data: { email: "source@example.com", activated_at: null } },
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
      adminTableResults = {
        profiles: {
          data: { email: "source@example.com", activated_at: null },
        },
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
    adminTableResults = {
      profiles: {
        data: { email: "pending@example.com", activated_at: null },
      },
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
    adminTableResults = {
      profiles: {
        data: {
          email: "administrative@example.com",
          activated_at: "2026-01-01",
        },
      },
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
    adminTableResults = {
      profiles: {
        data: { email: "reassigned@example.com", activated_at: "2026-01-01" },
      },
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
    adminTableResults = {
      profiles: { data: { email: "source@example.com", activated_at: null } },
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
    adminTableResults = {
      profiles: { data: { email: "source@example.com", activated_at: null } },
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
    expect(hoisted.revalidateTag).not.toHaveBeenCalled();
  });
});
