import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock do supabase admin client — captura os payloads de upsert para
// validar o que o codigo enviaria ao DB sem subir Postgres.
type UpsertCall = {
  table: string;
  rows: unknown;
  options: unknown;
};

interface MockState {
  project: { pydantic_fields: unknown } | null;
  humanResponse: { id: string; answers: Record<string, unknown> } | null;
  llmResponse: { id: string; answers: Record<string, unknown> } | null;
  upserts: UpsertCall[];
}

let state: MockState;

beforeEach(() => {
  state = {
    project: null,
    humanResponse: null,
    llmResponse: null,
    upserts: [],
  };
});

// Mock factory cria um novo cliente por chamada — `respCalls` fica local ao
// cliente, entao o segundo `maybeSingle` do mesmo `createAutoReviewIfDiverges`
// retorna o llmResponse mesmo quando os dois encadeamentos rodam em
// Promise.all.
vi.mock("@/lib/supabase/admin", () => {
  const adminFactory = () => {
    let respCalls = 0;
    return {
      from: (table: string) => {
        if (table === "projects") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: state.project, error: null }),
              }),
            }),
          };
        }
        if (table === "responses") {
          const chain: Record<string, unknown> = {};
          chain.select = () => chain;
          chain.eq = () => chain;
          chain.maybeSingle = async () => {
            respCalls++;
            return {
              data: respCalls === 1 ? state.humanResponse : state.llmResponse,
            };
          };
          return chain;
        }
        if (table === "assignments" || table === "field_reviews") {
          return {
            upsert: async (rows: unknown, options: unknown) => {
              state.upserts.push({ table, rows, options });
              return { error: null };
            },
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    };
  };
  return { createSupabaseAdmin: adminFactory };
});

describe("createAutoReviewIfDiverges", () => {
  it("sem projeto/respostas → divergentCount=0 e nenhum upsert", async () => {
    const { createAutoReviewIfDiverges } = await import("@/lib/auto-review");
    state.project = null;
    const r = await createAutoReviewIfDiverges("p1", "doc1", "user1");
    expect(r.divergentCount).toBe(0);
    expect(state.upserts).toHaveLength(0);
  });

  it("respostas iguais → divergentCount=0 e nenhum upsert", async () => {
    const { createAutoReviewIfDiverges } = await import("@/lib/auto-review");
    state.project = {
      pydantic_fields: [
        { name: "q1", type: "single", options: ["a", "b"], target: "all" },
      ],
    };
    state.humanResponse = { id: "h1", answers: { q1: "a" } };
    state.llmResponse = { id: "l1", answers: { q1: "a" } };
    const r = await createAutoReviewIfDiverges("p1", "doc1", "user1");
    expect(r.divergentCount).toBe(0);
    expect(state.upserts).toHaveLength(0);
  });

  it("respostas divergentes → cria 1 assignment + N field_reviews", async () => {
    const { createAutoReviewIfDiverges } = await import("@/lib/auto-review");
    state.project = {
      pydantic_fields: [
        { name: "q1", type: "single", options: ["a", "b"], target: "all" },
        { name: "q2", type: "single", options: ["x", "y"], target: "all" },
      ],
    };
    state.humanResponse = { id: "h1", answers: { q1: "a", q2: "x" } };
    state.llmResponse = { id: "l1", answers: { q1: "b", q2: "x" } };

    const r = await createAutoReviewIfDiverges("p1", "doc1", "user1");

    // Apenas q1 diverge
    expect(r.divergentCount).toBe(1);

    const assignmentUpsert = state.upserts.find(
      (u) => u.table === "assignments",
    );
    expect(assignmentUpsert).toBeDefined();
    expect(assignmentUpsert?.rows).toMatchObject({
      project_id: "p1",
      document_id: "doc1",
      user_id: "user1",
      type: "auto_revisao",
      status: "pendente",
    });

    const frUpsert = state.upserts.find((u) => u.table === "field_reviews");
    expect(frUpsert).toBeDefined();
    expect(Array.isArray(frUpsert?.rows)).toBe(true);
    const rows = frUpsert?.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: "p1",
      document_id: "doc1",
      field_name: "q1",
      human_response_id: "h1",
      llm_response_id: "l1",
      self_reviewer_id: "user1",
    });
  });

  it("upserts usam ignoreDuplicates (idempotencia)", async () => {
    const { createAutoReviewIfDiverges } = await import("@/lib/auto-review");
    state.project = {
      pydantic_fields: [
        { name: "q1", type: "single", options: ["a", "b"], target: "all" },
      ],
    };
    state.humanResponse = { id: "h1", answers: { q1: "a" } };
    state.llmResponse = { id: "l1", answers: { q1: "b" } };

    await createAutoReviewIfDiverges("p1", "doc1", "user1");

    for (const u of state.upserts) {
      expect(u.options).toMatchObject({ ignoreDuplicates: true });
    }
  });
});
