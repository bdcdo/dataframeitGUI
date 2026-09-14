import { describe, it, expect, beforeEach, vi } from "vitest";

// Caracterização das 10 funções resolve/reopen de stats.ts (5 pares, sobre 5
// tabelas) — nenhuma tinha teste antes do #385. O objetivo aqui não é repetir
// as 4 asserções por tabela: um par (resolveNote/reopenNote) é coberto em
// detalhe (sucesso, erro do Supabase, not-found no reopen); o guard de
// withResolutionAction é testado uma vez (é idêntico nas 10); as demais 8
// funções ganham 1 teste de fumaça de caminho feliz cada, o suficiente para
// pegar regressão na migração pro wrapper.
import { createSupabaseMockState } from "./supabase-mock";
import { resolutionFixture } from "@/lib/__tests__/error-resolution-fixture";

const supabaseState = createSupabaseMockState();

const hoisted = vi.hoisted(() => ({
  rpc: vi.fn(),
  revalidate: vi.fn(),
  getUser: vi.fn<() => Promise<{ id: string } | null>>(async () => ({
    id: "user1",
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => hoisted.revalidate(...args) }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: () => hoisted.getUser(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({ ...supabaseState.createClient(), rpc: hoisted.rpc }),
}));

beforeEach(() => {
  supabaseState.reset();
  hoisted.rpc.mockReset();
  hoisted.revalidate.mockReset();
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
    expect(supabaseState.writeCalls).toHaveLength(0);
  });
});

describe("resolveNote / reopenNote", () => {
  it("resolveNote: sucesso → insert em note_resolutions e revalida", async () => {
    const { resolveNote } = await loadStats();

    const r = await resolveNote("p1", "resp1", "nota");

    expect(r).toEqual({ success: true });
    expect(supabaseState.writeCalls).toEqual([
      {
        table: "note_resolutions",
        op: "insert",
        payload: {
          project_id: "p1",
          response_id: "resp1",
          resolved_by: "user1",
          note: "nota",
        },
      },
    ]);
  });

  it("resolveNote: nota omitida → grava note: null", async () => {
    const { resolveNote } = await loadStats();

    await resolveNote("p1", "resp1");

    expect(
      (supabaseState.writeCalls[0].payload as { note: string | null }).note,
    ).toBeNull();
  });

  it("resolveNote: erro do Supabase → error, sem revalidar", async () => {
    supabaseState.tableResults = {
      note_resolutions: [{ error: { message: "insert failed" } }],
    };
    const { resolveNote } = await loadStats();

    const r = await resolveNote("p1", "resp1", "nota");

    expect(r).toEqual({ success: false, error: "insert failed" });
  });

  it("reopenNote: sucesso → delete e retorna success", async () => {
    supabaseState.tableResults = {
      note_resolutions: [{ data: [{ response_id: "resp1" }] }],
    };
    const { reopenNote } = await loadStats();

    const r = await reopenNote("p1", "resp1");

    expect(r).toEqual({ success: true });
    expect(supabaseState.writeCalls[0]).toMatchObject({
      table: "note_resolutions",
      op: "delete",
    });
  });

  it("reopenNote: nada afetado → error de not-found (sem permissão ou já reaberta)", async () => {
    supabaseState.tableResults = { note_resolutions: [{ data: [] }] };
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
    supabaseState.tableResults = { reviews: [{ data: [{ id: "rv1" }] }] };
    const { resolveReviewComment } = await loadStats();

    const r = await resolveReviewComment("rv1", "p1");

    expect(r).toEqual({ success: true });
  });

  it("reopenReviewComment: sucesso", async () => {
    supabaseState.tableResults = { reviews: [{ data: [{ id: "rv1" }] }] };
    const { reopenReviewComment } = await loadStats();

    const r = await reopenReviewComment("rv1", "p1");

    expect(r).toEqual({ success: true });
  });
});

describe("resolveDuvida / reopenDuvida — smoke", () => {
  it("resolveDuvida: sucesso", async () => {
    supabaseState.tableResults = {
      verdict_acknowledgments: [{ data: [{ review_id: "rv1" }] }],
    };
    const { resolveDuvida } = await loadStats();

    const r = await resolveDuvida("p1", "rv1", "user2");

    expect(r).toEqual({ success: true });
  });

  it("reopenDuvida: sucesso", async () => {
    supabaseState.tableResults = {
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
    supabaseState.tableResults = {
      difficulty_resolutions: [{ data: [{ response_id: "resp1" }] }],
    };
    const { reopenDifficulty } = await loadStats();

    const r = await reopenDifficulty("p1", "resp1");

    expect(r).toEqual({ success: true });
  });
});

describe("resolveError / reopenError", () => {
  const row = resolutionFixture();
  const input = { decision: "llm_correct" as const, context: row.context!, expected: null, note: "Conferido" };

  it("salva contexto e escolha pela RPC, sem gravar diretamente a tabela", async () => {
    hoisted.rpc.mockResolvedValue({ data: row, error: null });
    const { resolveError } = await loadStats();
    expect(await resolveError("p1", "doc1", "x", input)).toEqual({ success: true });
    expect(hoisted.rpc).toHaveBeenCalledWith("set_error_resolution", {
      p_project_id: "p1", p_document_id: "doc1", p_field_name: "x",
      p_decision: "llm_correct", p_expected_context: row.context,
      p_expected_id: null, p_expected_resolved_at: null, p_note: "Conferido",
    });
    expect(supabaseState.writeCalls).toHaveLength(0);
    expect(hoisted.revalidate).toHaveBeenCalledWith("/projects/p1/reviews/gabarito");
  });

  it.each(["Sem permissão", "As respostas mudaram", "A decisão mudou"])("não anuncia sucesso para %s", async (message) => {
    hoisted.rpc.mockResolvedValue({ data: null, error: { message } });
    const { resolveError } = await loadStats();
    expect(await resolveError("p1", "doc1", "x", input)).toEqual({ success: false, error: message });
    expect(hoisted.revalidate).not.toHaveBeenCalled();
  });

  it("sem confirmação do banco não assume que salvou", async () => {
    hoisted.rpc.mockResolvedValue({ data: null, error: null });
    const { resolveError } = await loadStats();
    expect((await resolveError("p1", "doc1", "x", input)).success).toBe(false);
  });

  it("reabertura exige a identidade e a data que a pessoa examinou", async () => {
    hoisted.rpc.mockResolvedValue({ data: { reopened: true }, error: null });
    const { reopenError } = await loadStats();
    expect(await reopenError("p1", "doc1", "x", row)).toEqual({ success: true });
    expect(hoisted.rpc).toHaveBeenCalledWith("set_error_resolution", expect.objectContaining({
      p_decision: null, p_expected_id: row.id, p_expected_resolved_at: row.resolved_at,
    }));
    expect(supabaseState.writeCalls).toHaveLength(0);
  });

  it("preparar a confirmação lê contexto sem gravar decisão", async () => {
    hoisted.rpc.mockResolvedValue({ data: row.context, error: null });
    const { prepareErrorResolution } = await loadStats();
    expect(await prepareErrorResolution({ projectId: "p1", documentId: "doc1", fieldName: "x", llmResponseId: "rllm", humanResponseId: "rh", sourceKind: "comparacao", sourceId: "review1" })).toEqual({ context: row.context });
    expect(hoisted.rpc).toHaveBeenCalledTimes(1);
    expect(hoisted.rpc).toHaveBeenCalledWith("llm_error_context", expect.any(Object));
    expect(supabaseState.writeCalls).toHaveLength(0);
  });
});
