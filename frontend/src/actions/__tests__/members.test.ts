import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock supabase chainable enxuto. setCanArbitrate executa um UPDATE em
// project_members com .select("user_id").single() e dispara
// releaseArbitrationsFromUser / retryPendingArbitrations (mockados abaixo).
type WriteCall = { table: string; op: string; payload: unknown };
let writeCalls: WriteCall[];

function makeClient(updateError?: { message: string }) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["eq", "is", "in", "neq", "select", "single"]) {
        builder[m] = () => builder;
      }
      builder.update = (payload: unknown) => {
        writeCalls.push({ table, op: "update", payload });
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data: updateError ? null : { user_id: "userMemberX" },
          error: updateError ?? null,
        });
      return builder;
    },
  };
}

let clientError: { message: string } | undefined;

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
  releaseArbitrationsFromUser: hoisted.release,
}));

beforeEach(() => {
  writeCalls = [];
  clientError = undefined;
  hoisted.retry.mockReset();
  hoisted.retry.mockResolvedValue({ success: true, assigned: 0, stillNoPool: 0 });
  hoisted.release.mockReset();
  hoisted.release.mockResolvedValue({ released: 0 });
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
