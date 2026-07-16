import { describe, it, expect, beforeEach, vi } from "vitest";

// Caracterização das 10 funções resolve/reopen de stats.ts (5 pares, sobre 5
// tabelas) — nenhuma tinha teste antes do #385. O objetivo aqui não é repetir
// as 4 asserções por tabela: um par (resolveNote/reopenNote) é coberto em
// detalhe (sucesso, erro do Supabase, not-found no reopen); o guard de
// withResolutionAction é testado uma vez (é idêntico nas 10); as demais 8
// funções ganham 1 teste de fumaça de caminho feliz cada, o suficiente para
// pegar regressão na migração pro wrapper.
import {
  makeSupabaseMock,
  type RpcCall,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let serverTableResults: TableResults | undefined;

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn<() => Promise<{ id: string } | null>>(async () => ({ id: "user1" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: () => hoisted.getUser(),
  getEffectiveMemberId: async () => "member1",
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({ tableResults: serverTableResults, writeCalls, rpcCalls }),
}));

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  serverTableResults = undefined;
  hoisted.getUser.mockResolvedValue({ id: "user1" });
});

async function loadStats() {
  return await import("@/actions/stats");
}

describe("withResolutionAction — guard (via resolveNote, idêntico nas 10 funções)", () => {
  it("não autenticado → error, sem insert", async () => {
    hoisted.getUser.mockResolvedValueOnce(null);
    const { resolveNote } = await loadStats();

    const r = await resolveNote("p1", "resp1", "nota");

    expect(r).toEqual({ success: false, error: "Não autenticado" });
    expect(writeCalls).toHaveLength(0);
  });
});

describe("resolveNote / reopenNote", () => {
  it("resolveNote: sucesso → insert em note_resolutions e revalida", async () => {
    const { resolveNote } = await loadStats();

    const r = await resolveNote("p1", "resp1", "nota");

    expect(r).toEqual({ success: true });
    expect(writeCalls).toEqual([
      {
        table: "note_resolutions",
        op: "insert",
        payload: {
          project_id: "p1",
          response_id: "resp1",
          resolved_by: "member1",
          note: "nota",
        },
      },
    ]);
  });

  it("resolveNote: nota omitida → grava note: null", async () => {
    const { resolveNote } = await loadStats();

    await resolveNote("p1", "resp1");

    expect((writeCalls[0].payload as { note: string | null }).note).toBeNull();
  });

  it("resolveNote: erro do Supabase → error, sem revalidar", async () => {
    serverTableResults = {
      note_resolutions: [{ error: { message: "insert failed" } }],
    };
    const { resolveNote } = await loadStats();

    const r = await resolveNote("p1", "resp1", "nota");

    expect(r).toEqual({ success: false, error: "insert failed" });
  });

  it("reopenNote: sucesso → delete e retorna success", async () => {
    serverTableResults = {
      note_resolutions: [{ data: [{ response_id: "resp1" }] }],
    };
    const { reopenNote } = await loadStats();

    const r = await reopenNote("p1", "resp1");

    expect(r).toEqual({ success: true });
    expect(writeCalls[0]).toMatchObject({ table: "note_resolutions", op: "delete" });
  });

  it("reopenNote: nada afetado → error de not-found (sem permissão ou já reaberta)", async () => {
    serverTableResults = { note_resolutions: [{ data: [] }] };
    const { reopenNote } = await loadStats();

    const r = await reopenNote("p1", "resp1");

    expect(r).toEqual({
      success: false,
      error: "Nada reaberto: sem permissão ou anotação já reaberta",
    });
  });
});

describe("resolveReviewComment / reopenReviewComment — smoke", () => {
  it("resolveReviewComment: sucesso", async () => {
    serverTableResults = { reviews: [{ data: [{ id: "rv1" }] }] };
    const { resolveReviewComment } = await loadStats();

    const r = await resolveReviewComment("rv1", "p1");

    expect(r).toEqual({ success: true });
    expect(rpcCalls).toContainEqual({
      fn: "set_review_resolution",
      args: {
        p_project_id: "p1",
        p_review_id: "rv1",
        p_resolved: true,
        p_resolver_id: "member1",
      },
    });
  });

  it("reopenReviewComment: sucesso", async () => {
    serverTableResults = { reviews: [{ data: [{ id: "rv1" }] }] };
    const { reopenReviewComment } = await loadStats();

    const r = await reopenReviewComment("rv1", "p1");

    expect(r).toEqual({ success: true });
    expect(rpcCalls).toContainEqual({
      fn: "set_review_resolution",
      args: {
        p_project_id: "p1",
        p_review_id: "rv1",
        p_resolved: false,
        p_resolver_id: "member1",
      },
    });
  });
});

describe("resolveDuvida / reopenDuvida — smoke", () => {
  it("resolveDuvida: sucesso", async () => {
    serverTableResults = {
      verdict_acknowledgments: [{ data: [{ review_id: "rv1" }] }],
    };
    const { resolveDuvida } = await loadStats();

    const r = await resolveDuvida("p1", "rv1", "user2");

    expect(r).toEqual({ success: true });
  });

  it("reopenDuvida: sucesso", async () => {
    serverTableResults = {
      verdict_acknowledgments: [{ data: [{ review_id: "rv1" }] }],
    };
    const { reopenDuvida } = await loadStats();

    const r = await reopenDuvida("p1", "rv1", "user2");

    expect(r).toEqual({ success: true });
  });
});

describe("resolveDifficulty / reopenDifficulty — smoke", () => {
  it("resolveDifficulty: sucesso", async () => {
    const { resolveDifficulty } = await loadStats();

    const r = await resolveDifficulty("p1", "resp1", "doc1", "nota");

    expect(r).toEqual({ success: true });
  });

  it("reopenDifficulty: sucesso", async () => {
    serverTableResults = {
      difficulty_resolutions: [{ data: [{ response_id: "resp1" }] }],
    };
    const { reopenDifficulty } = await loadStats();

    const r = await reopenDifficulty("p1", "resp1");

    expect(r).toEqual({ success: true });
  });
});

describe("resolveError / reopenError — smoke", () => {
  it("resolveError: sucesso", async () => {
    const { resolveError } = await loadStats();

    const r = await resolveError("p1", "doc1", "campo1", "nota");

    expect(r).toEqual({ success: true });
  });

  it("reopenError: sucesso", async () => {
    serverTableResults = {
      error_resolutions: [{ data: [{ document_id: "doc1" }] }],
    };
    const { reopenError } = await loadStats();

    const r = await reopenError("p1", "doc1", "campo1");

    expect(r).toEqual({ success: true });
  });
});
