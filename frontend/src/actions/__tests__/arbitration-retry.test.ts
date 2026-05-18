import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock supabase chainable — mesmo padrão de field-reviews.test.ts. Captura
// payloads de write para validar o comportamento de retryPendingArbitrations
// e assignArbitrator sem subir Postgres.
type WriteCall = { table: string; op: string; payload: unknown };
let writeCalls: WriteCall[];
let tableData: Record<string, unknown>;

const updateCallsOf = (table?: string) =>
  writeCalls.filter((c) => c.op === "update" && (!table || c.table === table));
const upsertCallsOf = (table?: string) =>
  writeCalls.filter((c) => c.op === "upsert" && (!table || c.table === table));

function makeClient() {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      let op = "select";
      for (const m of ["select", "eq", "is", "in", "neq", "limit"]) {
        builder[m] = () => builder;
      }
      builder.update = (payload: unknown) => {
        writeCalls.push({ table, op: "update", payload });
        op = "update";
        return builder;
      };
      builder.upsert = (payload: unknown) => {
        writeCalls.push({ table, op: "upsert", payload });
        op = "upsert";
        return builder;
      };
      builder.insert = (payload: unknown) => {
        writeCalls.push({ table, op: "insert", payload });
        op = "insert";
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data: tableData[`${table}:${op}`] ?? tableData[table] ?? null,
          error: null,
        });
      return builder;
    },
  };
}

// isProjectCoordinator: hoisted para permitir override por teste.
const hoisted = vi.hoisted(() => ({
  isCoord: vi.fn<() => Promise<boolean>>(async () => true),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "userCoord" }),
  isProjectCoordinator: () => hoisted.isCoord(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeClient(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeClient(),
}));

beforeEach(() => {
  writeCalls = [];
  tableData = {
    field_reviews: [],
    project_members: [],
    assignments: [],
  };
  hoisted.isCoord.mockResolvedValue(true);
});

async function loadRetry() {
  return (await import("@/actions/field-reviews")).retryPendingArbitrations;
}

describe("retryPendingArbitrations — guards", () => {
  it("não-coordenador → erro, sem efeito colateral", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(false);
    expect(r.error).toContain("coordenadores");
    expect(r.assigned).toBe(0);
    expect(writeCalls).toHaveLength(0);
  });

  it("sem field_reviews pendentes → assigned 0 e nenhum UPDATE", async () => {
    tableData.field_reviews = [];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(0);
    expect(updateCallsOf("field_reviews")).toHaveLength(0);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });
});

describe("retryPendingArbitrations — agrupamento por (document_id, self_reviewer_id)", () => {
  it("dois fields do mesmo doc/self_reviewer → 1 chamada de assignArbitrator (1 UPDATE em field_reviews)", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
      { document_id: "doc1", field_name: "q2", self_reviewer_id: "userA" },
    ];
    // Pool com 1 árbitro elegível (assignArbitrator pode sortear)
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    // 1 grupo → 1 UPDATE em field_reviews atribuindo arbitrator_id
    expect(updateCallsOf("field_reviews")).toHaveLength(1);
    expect(updateCallsOf("field_reviews")[0].payload).toMatchObject({
      arbitrator_id: "userB",
    });
    // 1 grupo concluído → 1 upsert em assignments (arbitragem)
    expect(upsertCallsOf("assignments")).toHaveLength(1);
    expect(upsertCallsOf("assignments")[0].payload).toMatchObject({
      project_id: "p1",
      document_id: "doc1",
      user_id: "userB",
      type: "arbitragem",
    });
  });

  it("dois docs distintos → 2 chamadas de assignArbitrator (2 UPDATEs)", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
      { document_id: "doc2", field_name: "q1", self_reviewer_id: "userC" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(updateCallsOf("field_reviews")).toHaveLength(2);
    expect(upsertCallsOf("assignments")).toHaveLength(2);
  });

  it("self_reviewers diferentes no mesmo doc → 2 grupos (caso raro mas suportado)", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
      { document_id: "doc1", field_name: "q2", self_reviewer_id: "userC" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
    ];
    const retry = await loadRetry();
    await retry("p1");
    expect(updateCallsOf("field_reviews")).toHaveLength(2);
  });
});

describe("retryPendingArbitrations — pool vazio", () => {
  it("nenhum membro elegível → stillNoPool incrementa, sem UPDATE", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(1);
    expect(updateCallsOf("field_reviews")).toHaveLength(0);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });
});
