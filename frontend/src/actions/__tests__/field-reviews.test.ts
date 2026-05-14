import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock minimo do supabase: captura os payloads de .update() para validar o
// que submitAutoReview enviaria ao DB sem subir Postgres. Builder chainable e
// thenable — `await builder` (ou apos .select()) resolve { data, error }.
type UpdateCall = { table: string; payload: Record<string, unknown> };
let updateCalls: UpdateCall[];
let tableData: Record<string, unknown>;

function makeClient() {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "neq"]) {
        builder[m] = () => builder;
      }
      builder.update = (payload: Record<string, unknown>) => {
        updateCalls.push({ table, payload });
        return builder;
      };
      builder.upsert = () => builder;
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: tableData[table] ?? null, error: null });
      return builder;
    },
  };
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "user1" }),
  isProjectCoordinator: async () => false,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeClient(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeClient(),
}));

beforeEach(() => {
  updateCalls = [];
  tableData = {
    // UPDATE de field_reviews retorna a linha tocada (via .select)
    field_reviews: [{ field_name: "q1" }],
    // pool de arbitragem vazio → assignArbitrator curto-circuita sem erro
    project_members: [],
  };
});

async function loadSubmit() {
  return (await import("@/actions/field-reviews")).submitAutoReview;
}

describe("submitAutoReview — justificativa obrigatoria ao contestar o LLM", () => {
  it("contesta_llm sem justificativa → erro e nenhum UPDATE", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldName: "q1", verdict: "contesta_llm" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("justificativa obrigatória");
    expect(updateCalls).toHaveLength(0);
  });

  it("contesta_llm com justificativa só de espaços → erro e nenhum UPDATE", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldName: "q1", verdict: "contesta_llm", justification: "   \n\t" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("justificativa obrigatória");
    expect(updateCalls).toHaveLength(0);
  });

  it("admite_erro → passa na validacao e grava self_justification: null", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldName: "q1", verdict: "admite_erro" },
    ]);
    expect(r.success).toBe(true);
    const frUpdate = updateCalls.find((u) => u.table === "field_reviews");
    expect(frUpdate?.payload).toMatchObject({
      self_verdict: "admite_erro",
      self_justification: null,
    });
  });

  it("contesta_llm com justificativa → grava o texto trimado", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldName: "q1", verdict: "contesta_llm", justification: "  confere  " },
    ]);
    expect(r.success).toBe(true);
    const frUpdate = updateCalls.find((u) => u.table === "field_reviews");
    expect(frUpdate?.payload).toMatchObject({
      self_verdict: "contesta_llm",
      self_justification: "confere",
    });
  });
});
