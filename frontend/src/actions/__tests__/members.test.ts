import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock supabase chainable enxuto. setCanArbitrate executa um UPDATE em
// project_members com .select("user_id").single() e dispara
// releaseArbitrationsFromUser / retryPendingArbitrations (mockados abaixo).
// `tableResults` permite a testes (addMember) fixarem o retorno por tabela e
// por cliente (server vs admin); sem entrada, vale o default histórico.
type WriteCall = { table: string; op: string; payload: unknown };
let writeCalls: WriteCall[];

type TableResult = { data?: unknown; error?: { message: string; code?: string } | null };

function makeClient(
  updateError?: { message: string },
  tableResults?: Record<string, TableResult>,
) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["eq", "is", "in", "neq", "select", "single", "maybeSingle"]) {
        builder[m] = () => builder;
      }
      builder.update = (payload: unknown) => {
        writeCalls.push({ table, op: "update", payload });
        return builder;
      };
      builder.insert = (payload: unknown) => {
        writeCalls.push({ table, op: "insert", payload });
        return builder;
      };
      builder.delete = () => {
        writeCalls.push({ table, op: "delete", payload: null });
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) => {
        const fixed = tableResults?.[table];
        if (fixed) {
          return resolve({ data: fixed.data ?? null, error: fixed.error ?? null });
        }
        return resolve({
          data: updateError ? null : { user_id: "userMemberX" },
          error: updateError ?? null,
        });
      };
      return builder;
    },
  };
}

let clientError: { message: string } | undefined;
let serverTableResults: Record<string, TableResult> | undefined;
let adminTableResults: Record<string, TableResult> | undefined;

// hoisted mocks — release/retry precisam ser observáveis por teste para
// distinguir o caminho de habilitar vs desabilitar.
const hoisted = vi.hoisted(() => ({
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
  release: vi.fn<
    (
      projectId: string,
      userId: string,
    ) => Promise<{ released: number; error?: string }>
  >(async () => ({ released: 0 })),
  preregister: vi.fn<(email: string) => Promise<string>>(
    async () => "placeholderUid",
  ),
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "userCoord" }),
  isProjectCoordinator: async () => true,
}));
vi.mock("@/lib/clerk-sync", () => ({
  syncClerkUserToSupabase: async () => "userX",
  preregisterSupabaseUser: hoisted.preregister,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeClient(clientError, serverTableResults),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeClient(clientError, adminTableResults),
}));
vi.mock("@/actions/field-reviews", () => ({
  retryPendingArbitrations: hoisted.retry,
  releaseArbitrationsFromUser: hoisted.release,
}));

beforeEach(() => {
  writeCalls = [];
  clientError = undefined;
  serverTableResults = undefined;
  adminTableResults = undefined;
  hoisted.retry.mockReset();
  hoisted.retry.mockResolvedValue({ success: true, assigned: 0, stillNoPool: 0 });
  hoisted.release.mockReset();
  hoisted.release.mockResolvedValue({ released: 0 });
  hoisted.preregister.mockReset();
  hoisted.preregister.mockResolvedValue("placeholderUid");
});

async function loadSet() {
  return (await import("@/actions/members")).setCanArbitrate;
}

describe("setCanArbitrate", () => {
  it("habilita → dispara retry (sem release) e devolve contagem", async () => {
    hoisted.retry.mockResolvedValueOnce({
      success: true,
      assigned: 3,
      stillNoPool: 1,
    });
    const set = await loadSet();
    const r = await set("member1", true, "p1");
    expect(r.error).toBeUndefined();
    expect(r.retried).toEqual({ assigned: 3, stillNoPool: 1 });
    expect(hoisted.retry).toHaveBeenCalledWith("p1");
    expect(hoisted.release).not.toHaveBeenCalled();
    // UPDATE em project_members com can_arbitrate=true
    expect(writeCalls).toContainEqual({
      table: "project_members",
      op: "update",
      payload: { can_arbitrate: true },
    });
  });

  it("desabilita → solta arbitragens do membro e dispara retry", async () => {
    hoisted.retry.mockResolvedValueOnce({
      success: true,
      assigned: 2,
      stillNoPool: 0,
    });
    const set = await loadSet();
    const r = await set("member1", false, "p1");
    expect(r.error).toBeUndefined();
    // release recebe o user_id do membro (resolvido via .select().single())
    expect(hoisted.release).toHaveBeenCalledWith("p1", "userMemberX");
    expect(hoisted.retry).toHaveBeenCalledWith("p1");
    expect(r.retried).toEqual({ assigned: 2, stillNoPool: 0 });
    expect(writeCalls).toContainEqual({
      table: "project_members",
      op: "update",
      payload: { can_arbitrate: false },
    });
  });

  it("habilita mas retry falha → result.retried undefined, sem propagar erro", async () => {
    hoisted.retry.mockResolvedValueOnce({
      success: false,
      error: "kaboom",
      assigned: 0,
      stillNoPool: 0,
    });
    const set = await loadSet();
    const r = await set("member1", true, "p1");
    // setCanArbitrate em si não falha — o UPDATE em project_members deu certo.
    // O retry rodou em best-effort. Coordenador vê "habilitado" mas o banner
    // continua mostrando pendências se houver.
    expect(r.error).toBeUndefined();
    expect(r.retried).toBeUndefined();
  });

  it("UPDATE falha → retorna error e NÃO dispara release/retry", async () => {
    clientError = { message: "RLS bloqueou" };
    const set = await loadSet();
    const r = await set("member1", true, "p1");
    expect(r.error).toBe("RLS bloqueou");
    expect(hoisted.retry).not.toHaveBeenCalled();
    expect(hoisted.release).not.toHaveBeenCalled();
  });

  it("desabilita + release retorna error → propaga error e NÃO dispara retry", async () => {
    hoisted.release.mockResolvedValueOnce({
      released: 0,
      error: "RLS bloqueou release",
    });
    const set = await loadSet();
    const r = await set("member1", false, "p1");
    expect(r.error).toBe("RLS bloqueou release");
    expect(hoisted.release).toHaveBeenCalledWith("p1", "userMemberX");
    // retry filtra arbitrator_id IS NULL — não tocaria nos casos que ficaram
    // travados; rodar mesmo assim só faria queries inúteis e a UI poderia
    // mostrar "X realocados" enganosamente quando o release não rodou.
    expect(hoisted.retry).not.toHaveBeenCalled();
    expect(r.retried).toBeUndefined();
  });
});

async function loadSetResolve() {
  return (await import("@/actions/members")).setCanResolve;
}

describe("setCanResolve", () => {
  it("habilita → UPDATE com can_resolve=true e NÃO dispara retry de arbitragem", async () => {
    const set = await loadSetResolve();
    const r = await set("member1", true, "p1");
    expect(r.error).toBeUndefined();
    expect(hoisted.retry).not.toHaveBeenCalled();
    expect(writeCalls).toContainEqual({
      table: "project_members",
      op: "update",
      payload: { can_resolve: true },
    });
  });

  it("desabilita → UPDATE com can_resolve=false", async () => {
    const set = await loadSetResolve();
    const r = await set("member1", false, "p1");
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
    const r = await set("member1", true, "p1");
    expect(r.error).toBe("RLS bloqueou");
  });
});

async function loadAdd() {
  return (await import("@/actions/members")).addMember;
}

// O chamador é coordenador (server client devolve role coordenador); a
// variação fica por conta do lookup de profiles e do insert (admin client).
function setupAddMember(opts: {
  profile?: { id: string } | null;
  insertError?: { message: string; code?: string };
}) {
  serverTableResults = {
    project_members: { data: { role: "coordenador" } },
  };
  adminTableResults = {
    profiles: { data: opts.profile ?? null },
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
    expect(hoisted.preregister).toHaveBeenCalledWith("pessoa@exemplo.com");
    expect(writeCalls).toContainEqual({
      table: "project_members",
      op: "insert",
      payload: { project_id: "p1", user_id: "placeholderUid", role: "pesquisador" },
    });
  });

  it("e-mail com profile existente → comportamento atual, sem pré-registro", async () => {
    setupAddMember({ profile: { id: "existingUid" } });
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

  it("insert duplicado (23505) → mensagem de já membro", async () => {
    setupAddMember({
      profile: { id: "existingUid" },
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
