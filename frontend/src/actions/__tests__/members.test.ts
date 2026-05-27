import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock supabase chainable enxuto. setCanArbitrate só executa um UPDATE em
// project_members e dispara retryPendingArbitrations (mockado abaixo).
type WriteCall = { table: string; op: string; payload: unknown };
let writeCalls: WriteCall[];

function makeClient(updateError?: { message: string }) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["eq", "is", "in", "neq", "select"]) {
        builder[m] = () => builder;
      }
      builder.update = (payload: unknown) => {
        writeCalls.push({ table, op: "update", payload });
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: updateError ?? null });
      return builder;
    },
  };
}

let clientError: { message: string } | undefined;

// hoisted mocks — retryPendingArbitrations precisa ser observável por teste
// para distinguir "habilita dispara retry" vs "desabilita não dispara".
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
}));
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { getUserList: async () => ({ data: [] }), createUser: async () => ({ id: "x" }) },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeClient(clientError),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeClient(clientError),
}));
vi.mock("@/actions/field-reviews", () => ({
  retryPendingArbitrations: hoisted.retry,
}));

beforeEach(() => {
  writeCalls = [];
  clientError = undefined;
  hoisted.retry.mockReset();
  hoisted.retry.mockResolvedValue({ success: true, assigned: 0, stillNoPool: 0 });
});

async function loadSet() {
  return (await import("@/actions/members")).setCanArbitrate;
}

describe("setCanArbitrate", () => {
  it("habilita → dispara retryPendingArbitrations e devolve contagem", async () => {
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
    // UPDATE em project_members com can_arbitrate=true
    expect(writeCalls).toContainEqual({
      table: "project_members",
      op: "update",
      payload: { can_arbitrate: true },
    });
  });

  it("desabilita → NÃO dispara retry", async () => {
    const set = await loadSet();
    const r = await set("member1", false, "p1");
    expect(r.error).toBeUndefined();
    expect(r.retried).toBeUndefined();
    expect(hoisted.retry).not.toHaveBeenCalled();
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

  it("UPDATE falha → retorna error e NÃO dispara retry", async () => {
    clientError = { message: "RLS bloqueou" };
    const set = await loadSet();
    const r = await set("member1", true, "p1");
    expect(r.error).toBe("RLS bloqueou");
    expect(hoisted.retry).not.toHaveBeenCalled();
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
