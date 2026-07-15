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

function makeClient(
  updateError?: { message: string },
  tableResults?: TableResults,
  rpcResults?: Record<string, TableResult>,
) {
  return makeSupabaseMock({
    tableResults,
    defaultResult: updateError
      ? { data: null, error: updateError }
      : { data: { project_id: "p-derived", user_id: "userMemberX" } },
    writeCalls,
    filterCalls,
    rpcCalls,
    rpcResults,
  });
}

let clientError: { message: string } | undefined;
let serverTableResults: TableResults | undefined;
let adminTableResults: TableResults | undefined;
let serverRpcResults: Record<string, TableResult>;
let adminCreateCalls: number;

const hoisted = vi.hoisted(() => ({
  revalidatePath: vi.fn<(path: string) => void>(),
  revalidateTag: vi.fn<(tag: string, profile: unknown) => void>(),
  retry: vi.fn<(projectId: string) => Promise<{
    success: boolean;
    assigned: number;
    stillNoPool: number;
    error?: string;
  }>>(async () => ({
    success: true,
    assigned: 0,
    stillNoPool: 0,
  })),
  preregister: vi.fn<(email: string) => Promise<string>>(
    async () => "placeholderUid",
  ),
  retryComparisons: vi.fn<(projectId: string) => Promise<{
    success: boolean;
    assigned: number;
    stillNoPool: number;
    error?: string;
  }>>(async () => ({
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
vi.mock("@/lib/clerk-sync", () => ({
  syncClerkUserToSupabase: async () => "userX",
  preregisterSupabaseUser: hoisted.preregister,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeClient(clientError, serverTableResults, serverRpcResults),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => {
    adminCreateCalls++;
    return makeClient(clientError, adminTableResults);
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
  adminCreateCalls = 0;
  hoisted.revalidatePath.mockReset();
  hoisted.revalidateTag.mockReset();
  hoisted.retry.mockReset();
  hoisted.retry.mockResolvedValue({ success: true, assigned: 0, stillNoPool: 0 });
  hoisted.preregister.mockReset();
  hoisted.preregister.mockResolvedValue("placeholderUid");
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
      actions.unifyMembers("p1", "source", "target"),
      actions.unlinkMemberEmail("p1", "link1"),
    ]);

    expect(results).toEqual(
      Array.from({ length: 5 }, () => ({
        error: "Não foi possível verificar sua permissão. Tente novamente.",
      })),
    );
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
    expect(hoisted.revalidatePath).toHaveBeenCalledWith("/projects/p-canonical");
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
    expect(hoisted.revalidatePath).toHaveBeenCalledWith("/projects/p-canonical");
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

// O gate canônico autoriza o chamador; a variação fica por conta dos lookups
// (profiles, member_email_links) e do insert no admin client.
function setupAddMember(opts: {
  profile?: { id: string; activated_at: string | null } | null;
  emailLink?: { member_user_id: string } | null;
  insertError?: { message: string; code?: string };
}) {
  adminTableResults = {
    profiles: { data: opts.profile ?? null },
    member_email_links: { data: opts.emailLink ?? null },
    project_members: { data: null, error: opts.insertError ?? null },
  };
}

describe("addMember (pré-registro, spec 002)", () => {
  it("e-mail inválido → erro sem tocar no banco nem pré-registrar", async () => {
    const add = await loadAdd();
    const r = await add("p1", "sem-arroba", "pesquisador");
    expect(r.error).toBe("E-mail inválido.");
    expect(hoisted.preregister).not.toHaveBeenCalled();
    expect(writeCalls).toEqual([]);
  });

  it("normaliza e-mail (trim + lowercase) antes de pré-registrar", async () => {
    setupAddMember({ profile: null });
    const add = await loadAdd();
    const r = await add("p1", "  Pessoa@Exemplo.COM ", "pesquisador");
    expect(r.error).toBeUndefined();
    expect(r.pending).toBe(true);
    expect(hoisted.requireCoordinator).toHaveBeenCalledWith(
      "p1",
      "Apenas coordenadores podem adicionar membros.",
    );
    expect(hoisted.preregister).toHaveBeenCalledWith("pessoa@exemplo.com");
    expect(writeCalls).toContainEqual({
      table: "project_members",
      op: "insert",
      payload: { project_id: "p1", user_id: "placeholderUid", role: "pesquisador" },
    });
  });

  it("e-mail com profile existente ativo → comportamento atual, sem pré-registro", async () => {
    setupAddMember({ profile: { id: "existingUid", activated_at: "2026-01-01" } });
    const add = await loadAdd();
    const r = await add("p1", "ja-tem@conta.com", "pesquisador");
    expect(r.error).toBeUndefined();
    expect(r.pending).toBe(false);
    expect(hoisted.preregister).not.toHaveBeenCalled();
    expect(writeCalls).toContainEqual({
      table: "project_members",
      op: "insert",
      payload: { project_id: "p1", user_id: "existingUid", role: "pesquisador" },
    });
  });

  it("profile existente mas ainda pendente (pré-registrado em outro projeto) → pending true", async () => {
    setupAddMember({ profile: { id: "placeholderUid2", activated_at: null } });
    const add = await loadAdd();
    const r = await add("p1", "pendente@conta.com", "pesquisador");
    expect(r.error).toBeUndefined();
    expect(r.pending).toBe(true);
    expect(hoisted.preregister).not.toHaveBeenCalled();
  });

  it("e-mail vinculado a outro membro do projeto → erro orientando a desvincular", async () => {
    setupAddMember({
      profile: { id: "srcUid", activated_at: "2026-01-01" },
      emailLink: { member_user_id: "target1" },
    });
    const add = await loadAdd();
    const r = await add("p1", "vinculado@conta.com", "pesquisador");
    expect(r.error).toContain("vinculado a outro membro");
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
  });

  it("insert duplicado (23505) → mensagem de já membro", async () => {
    setupAddMember({
      profile: { id: "existingUid", activated_at: "2026-01-01" },
      insertError: { message: "duplicate key", code: "23505" },
    });
    const add = await loadAdd();
    const r = await add("p1", "ja-tem@conta.com", "pesquisador");
    expect(r.error).toBe("Usuário já é membro deste projeto.");
  });

  it("falha no pré-registro → erro amigável, sem insert em project_members", async () => {
    setupAddMember({ profile: null });
    hoisted.preregister.mockRejectedValueOnce(new Error("kaboom"));
    const add = await loadAdd();
    const r = await add("p1", "novo@exemplo.com", "pesquisador");
    expect(r.error).toBe("Erro ao pré-registrar: kaboom");
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
  });
});

async function loadLink() {
  return (await import("@/actions/members")).linkMemberEmail;
}

// Matriz do contrato de linkMemberEmail. As queries ao admin client seguem a
// ordem do Promise.all (project_members, member_email_links, profiles) e, no
// caso 2, a segunda leitura de project_members é o membership do dono do
// e-mail — daí as filas por tabela.
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

  it("caso 1: e-mail já vinculado no projeto → erro com o membro atual", async () => {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: { data: { id: "l0", member_user_id: "outro1" } },
      profiles: { data: { id: "outro1", first_name: "Ana", email: "ana@x.com" } },
    };
    const link = await loadLink();
    const r = await link("p1", "target1", "extra@exemplo.com");
    expect(r.error).toBe("Este e-mail já está vinculado a Ana neste projeto.");
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
  });

  it("caso 2: e-mail principal de outro membro → requiresUnification com preview, sem executar", async () => {
    adminTableResults = {
      project_members: [
        { data: { role: "coordenador" } }, // membership do target
        { data: { id: "pmSource" } }, // membership do dono do e-mail
      ],
      member_email_links: { data: null },
      profiles: { data: { id: "src1", first_name: "Beto", email: "beto@x.com" } },
      assignments: { count: 7 },
      responses: {
        data: [
          { document_id: "docA", respondent_id: "src1" },
          { document_id: "docA", respondent_id: "target1" },
          { document_id: "docB", respondent_id: "src1" },
          { document_id: "docC", respondent_id: "target1" },
        ],
      },
    };
    const link = await loadLink();
    const r = await link("p1", "target1", "beto@x.com");
    expect(r.error).toBeUndefined();
    expect(r.requiresUnification).toEqual({
      sourceUserId: "src1",
      sourceName: "Beto",
      targetUserId: "target1",
      assignmentsToMigrate: 7,
      docsWithBothResponses: 1,
      resultingRole: "coordenador",
    });
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
  });

  it("caso 3: conta existente não-membro → insert com linked_user_id preenchido", async () => {
    adminTableResults = {
      project_members: [
        { data: { role: "pesquisador" } },
        { data: null }, // dono do e-mail não é membro
      ],
      member_email_links: [
        { data: null }, // leitura: sem link
        { data: { ...LINK_ROW, linked_user_id: "acc1" } }, // retorno do insert
      ],
      profiles: { data: { id: "acc1", first_name: null, email: "extra@exemplo.com" } },
    };
    const link = await loadLink();
    const r = await link("p1", "target1", "Extra@Exemplo.com");
    expect(r.error).toBeUndefined();
    expect(r.link?.linked_user_id).toBe("acc1");
    expect(writeCalls).toContainEqual({
      table: "member_email_links",
      op: "insert",
      payload: {
        project_id: "p1",
        member_user_id: "target1",
        email: "extra@exemplo.com",
        linked_user_id: "acc1",
        created_by: "userCoord",
      },
    });
  });

  it("caso 4: e-mail sem conta → insert com linked_user_id NULL (pré-registro do e-mail)", async () => {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: [
        { data: null },
        { data: LINK_ROW },
      ],
      profiles: { data: null },
    };
    const link = await loadLink();
    const r = await link("p1", "target1", "extra@exemplo.com");
    expect(r.error).toBeUndefined();
    expect(r.link?.linked_user_id).toBeNull();
    expect(writeCalls).toContainEqual({
      table: "member_email_links",
      op: "insert",
      payload: {
        project_id: "p1",
        member_user_id: "target1",
        email: "extra@exemplo.com",
        linked_user_id: null,
        created_by: "userCoord",
      },
    });
  });

  it("e-mail principal do próprio membro → erro sem insert", async () => {
    adminTableResults = {
      project_members: { data: { role: "pesquisador" } },
      member_email_links: { data: null },
      profiles: { data: { id: "target1", first_name: null, email: "eu@x.com" } },
    };
    const link = await loadLink();
    const r = await link("p1", "target1", "eu@x.com");
    expect(r.error).toBe("Este já é o e-mail principal deste membro.");
    expect(writeCalls.filter((c) => c.op === "insert")).toEqual([]);
  });
});
