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
      builder.delete = () => {
        writeCalls.push({ table, op: "delete", payload: null });
        op = "delete";
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data: tableData[`${table}:${op}`] ?? tableData[table] ?? null,
          error: tableData[`__error:${table}:${op}`] ?? null,
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
  requireCoordinator: async (_projectId: string, deniedMessage: string) => {
    if (!(await hoisted.isCoord())) return { ok: false, error: deniedMessage };
    return { ok: true, user: { id: "userCoord" } };
  },
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
    responses: [],
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

describe("retryPendingArbitrations — exclui codificadores do documento", () => {
  it("membro que codificou o doc é excluído do pool", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
      { user_id: "userC", role: "pesquisador" },
    ];
    // userB deu resposta humana em doc1 → não pode arbitrar (juiz em causa própria)
    tableData.responses = [{ document_id: "doc1", respondent_id: "userB" }];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(updateCallsOf("field_reviews")).toHaveLength(1);
    expect(updateCallsOf("field_reviews")[0].payload).toMatchObject({
      arbitrator_id: "userC",
    });
  });

  it("todos os elegíveis codificaram o doc → fallback para elegível != auto-revisor", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
      { user_id: "userC", role: "pesquisador" },
    ];
    // Doc codificado por toda a equipe elegível (caso de calibração): nenhum
    // árbitro totalmente neutro, mas userB/userC não são o auto-revisor userA.
    tableData.responses = [
      { document_id: "doc1", respondent_id: "userB" },
      { document_id: "doc1", respondent_id: "userC" },
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(1);
    expect(r.stillNoPool).toBe(0);
    expect(updateCallsOf("field_reviews")).toHaveLength(1);
    const payload = updateCallsOf("field_reviews")[0].payload as {
      arbitrator_id: string;
    };
    expect(["userB", "userC"]).toContain(payload.arbitrator_id);
  });

  it("único elegível é o próprio auto-revisor → stillNoPool, sem UPDATE", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [{ user_id: "userA", role: "pesquisador" }];
    tableData.responses = [{ document_id: "doc1", respondent_id: "userA" }];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(1);
    expect(updateCallsOf("field_reviews")).toHaveLength(0);
  });
});

async function loadRelease() {
  return (await import("@/actions/field-reviews")).releaseArbitrationsFromUser;
}

const deleteCallsOf = (table?: string) =>
  writeCalls.filter((c) => c.op === "delete" && (!table || c.table === table));

describe("releaseArbitrationsFromUser", () => {
  it("sem field_reviews afetados → released 0, nenhum write", async () => {
    tableData.field_reviews = [];
    const release = await loadRelease();
    const r = await release("p1", "userX");
    expect(r.released).toBe(0);
    expect(r.error).toBeUndefined();
    expect(writeCalls).toHaveLength(0);
  });

  it("N afetados → UPDATE primeiro, DELETE depois, released N", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1" },
      { id: "fr2", document_id: "doc1" },
      { id: "fr3", document_id: "doc2" },
    ];
    const release = await loadRelease();
    const r = await release("p1", "userX");
    expect(r.released).toBe(3);
    expect(r.error).toBeUndefined();
    // 1 UPDATE em field_reviews zerando arbitrator_id/blind_verdict/blind_decided_at
    const upd = updateCallsOf("field_reviews");
    expect(upd).toHaveLength(1);
    expect(upd[0].payload).toEqual({
      arbitrator_id: null,
      blind_verdict: null,
      blind_decided_at: null,
    });
    // 1 DELETE em assignments (árbitragens órfãs do ex-árbitro)
    expect(deleteCallsOf("assignments")).toHaveLength(1);
    // Ordem importa: UPDATE precede DELETE (estado autocorrigível se DELETE
    // falhar; ordem inversa deixaria field_reviews presos ao ex-árbitro).
    const updIdx = writeCalls.findIndex(
      (c) => c.op === "update" && c.table === "field_reviews",
    );
    const delIdx = writeCalls.findIndex(
      (c) => c.op === "delete" && c.table === "assignments",
    );
    expect(updIdx).toBeLessThan(delIdx);
  });

  it("UPDATE falha → released 0, error preenchido, sem DELETE", async () => {
    tableData.field_reviews = [{ id: "fr1", document_id: "doc1" }];
    tableData["__error:field_reviews:update"] = { message: "RLS bloqueou update" };
    const release = await loadRelease();
    const r = await release("p1", "userX");
    expect(r.released).toBe(0);
    expect(r.error).toBe("RLS bloqueou update");
    // Sem DELETE: a função sai antes — UPDATE falhou, então não toca assignments.
    expect(deleteCallsOf("assignments")).toHaveLength(0);
  });

  it("DELETE falha → released N (estado já liberado), error preenchido", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1" },
      { id: "fr2", document_id: "doc2" },
    ];
    tableData["__error:assignments:delete"] = { message: "RLS bloqueou delete" };
    const release = await loadRelease();
    const r = await release("p1", "userX");
    // UPDATE foi aplicado (released = 2) mas DELETE falhou. Estado é
    // autocorrigível: field_reviews já têm arbitrator_id NULL.
    expect(r.released).toBe(2);
    expect(r.error).toBe("RLS bloqueou delete");
    expect(updateCallsOf("field_reviews")).toHaveLength(1);
  });
});

describe("retryPendingArbitrations — batch de responses agrupado por doc", () => {
  it("dois docs com codificadores distintos → cada assignArbitrator vê só o seu doc", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
      { document_id: "doc2", field_name: "q1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
      { user_id: "userC", role: "pesquisador" },
    ];
    // userB codificou doc1; userC codificou doc2. Pool por doc deve excluir
    // só o codificador daquele doc — não confundir entre docs.
    tableData.responses = [
      { document_id: "doc1", respondent_id: "userB" },
      { document_id: "doc2", respondent_id: "userC" },
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    const upd = updateCallsOf("field_reviews");
    expect(upd).toHaveLength(2);
    const arbitrators = upd
      .map((c) => (c.payload as { arbitrator_id: string }).arbitrator_id)
      .sort();
    // doc1 só pode ir pra userC (userB codificou); doc2 só pra userB
    // (userC codificou). Sem batch correto por doc, ambas as chamadas
    // veriam o conjunto union {userB, userC} e cairiam no fallback,
    // sorteando qualquer um — quebrando a isolação por documento.
    expect(arbitrators).toEqual(["userB", "userC"]);
  });
});

// regenerateAutoReviewBacklog não tinha nenhum teste antes do #385 — passou a
// reusar o mesmo requireCoordinator de retryPendingArbitrations (mesmo
// arquivo), então o gap real a fechar é o guard.
async function loadRegenerate() {
  return (await import("@/actions/field-reviews")).regenerateAutoReviewBacklog;
}

describe("regenerateAutoReviewBacklog — guard", () => {
  it("não-coordenador → erro, sem efeito colateral", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const regenerate = await loadRegenerate();

    const r = await regenerate("p1");

    expect(r.success).toBe(false);
    expect(r.error).toContain("coordenadores");
    expect(writeCalls).toHaveLength(0);
  });
});
