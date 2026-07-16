import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseAdminModuleMock,
  makeSupabaseServerModuleMock,
  makeSimpleSupabaseMock,
  type QueryError,
  type RpcCall,
  type RpcResult,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { authModuleMock } from "@/test-utils/auth-mock";

// Mock supabase chainable — mesmo padrão de field-reviews.test.ts. Captura a
// RPC que faz o commit atômico de retryPendingArbitrations/assignArbitrator
// sem subir Postgres.
let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let rpcResults: Record<string, RpcResult>;
let tableData: Record<string, unknown>;
let queryErrors: Record<string, QueryError | null>;

const arbitrationCalls = () =>
  rpcCalls.filter((call) => call.fn === "assign_arbitration_if_eligible");

function makeClient() {
  return makeSimpleSupabaseMock({
    tableData,
    writeCalls,
    rpcCalls,
    rpcResults,
    queryErrors,
  });
}

const coordinatorGate = vi.hoisted(() =>
  vi.fn<() => Promise<boolean>>(async () => true),
);
const adminFactory = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => authModuleMock(coordinatorGate));
vi.mock("@/lib/supabase/server", () =>
  makeSupabaseServerModuleMock(makeClient),
);
vi.mock("@/lib/supabase/admin", () =>
  makeSupabaseAdminModuleMock(makeClient, adminFactory),
);

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  rpcResults = {
    assign_arbitration_if_eligible: { data: 1 },
  };
  tableData = {
    field_reviews: [],
    project_members: [],
    assignments: [],
    responses: [],
  };
  queryErrors = {};
  adminFactory.mockClear();
  coordinatorGate.mockResolvedValue(true);
});

async function loadRetry() {
  return (await import("@/actions/field-reviews")).retryPendingArbitrations;
}

async function runRetry() {
  return (await loadRetry())("p1");
}

async function expectSuccessfulRetry(assigned: number, stillNoPool: number) {
  const result = await runRetry();
  expect(result).toMatchObject({ success: true, assigned, stillNoPool });
  return result;
}

describe("retryPendingArbitrations — guards", () => {
  it("não-coordenador → erro, sem efeito colateral", async () => {
    coordinatorGate.mockResolvedValueOnce(false);
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(false);
    expect(r.error).toContain("coordenadores");
    expect(r.assigned).toBe(0);
    expect(writeCalls).toHaveLength(0);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it("sem field_reviews pendentes → assigned 0 e nenhuma RPC", async () => {
    tableData.field_reviews = [];
    await expectSuccessfulRetry(0, 0);
    expect(arbitrationCalls()).toHaveLength(0);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it("falha ao carregar codificadores → erro técnico, sem RPC", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [{ user_id: "userB", role: "pesquisador" }];
    queryErrors["responses:select"] = {
      message: "falha ao carregar codificadores",
    };

    const retry = await loadRetry();
    const result = await retry("p1");

    expect(result).toMatchObject({
      success: false,
      error: "falha ao carregar codificadores",
      assigned: 0,
      stillNoPool: 0,
    });
    expect(arbitrationCalls()).toHaveLength(0);
  });
});

describe("retryPendingArbitrations — agrupamento por (document_id, self_reviewer_id)", () => {
  it("dois fields do mesmo doc/self_reviewer → 1 commit atômico", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
      { document_id: "doc1", field_name: "q2", self_reviewer_id: "userA" },
    ];
    // Pool com 1 árbitro elegível (assignArbitrator pode sortear)
    tableData.project_members = [{ user_id: "userB", role: "pesquisador" }];
    await expectSuccessfulRetry(1, 0);
    expect(arbitrationCalls()).toHaveLength(1);
    expect(arbitrationCalls()[0].args).toEqual({
      p_project_id: "p1",
      p_document_id: "doc1",
      p_user_id: "userB",
      p_field_names: ["q1", "q2"],
    });
    expect(writeCalls).toHaveLength(0);
  });

  it("dois docs distintos → 2 commits atômicos", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
      { document_id: "doc2", field_name: "q1", self_reviewer_id: "userC" },
    ];
    tableData.project_members = [{ user_id: "userB", role: "pesquisador" }];
    await expectSuccessfulRetry(2, 0);
    expect(arbitrationCalls()).toHaveLength(2);
    expect(writeCalls).toHaveLength(0);
  });

  it("self_reviewers diferentes no mesmo doc → 2 grupos (caso raro mas suportado)", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
      { document_id: "doc1", field_name: "q2", self_reviewer_id: "userC" },
    ];
    tableData.project_members = [{ user_id: "userB", role: "pesquisador" }];
    await expectSuccessfulRetry(2, 0);
    expect(arbitrationCalls()).toHaveLength(2);
  });
});

describe("retryPendingArbitrations — pool vazio", () => {
  it("nenhum membro elegível → stillNoPool incrementa, sem UPDATE", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [];
    await expectSuccessfulRetry(0, 1);
    expect(arbitrationCalls()).toHaveLength(0);
  });

  it("candidato desabilitado antes do commit → RPC não grava", async () => {
    tableData.field_reviews = [
      { document_id: "doc1", field_name: "q1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [{ user_id: "userB", role: "pesquisador" }];
    rpcResults.assign_arbitration_if_eligible = { data: 0 };

    const retry = await loadRetry();

    expect(await retry("p1")).toMatchObject({
      success: true,
      assigned: 0,
      stillNoPool: 0,
    });
    expect(arbitrationCalls()).toHaveLength(1);
    expect(writeCalls).toHaveLength(0);
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
    await expectSuccessfulRetry(1, 0);
    expect(arbitrationCalls()).toHaveLength(1);
    expect(arbitrationCalls()[0].args).toMatchObject({ p_user_id: "userC" });
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
    await expectSuccessfulRetry(1, 0);
    expect(arbitrationCalls()).toHaveLength(1);
    const args = arbitrationCalls()[0].args as { p_user_id: string };
    expect(["userB", "userC"]).toContain(args.p_user_id);
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
    expect(arbitrationCalls()).toHaveLength(0);
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
    const calls = arbitrationCalls();
    expect(calls).toHaveLength(2);
    const arbitrators = calls
      .map((call) => (call.args as { p_user_id: string }).p_user_id)
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
    coordinatorGate.mockResolvedValueOnce(false);
    const regenerate = await loadRegenerate();

    const r = await regenerate("p1");

    expect(r.success).toBe(false);
    expect(r.error).toContain("coordenadores");
    expect(writeCalls).toHaveLength(0);
    expect(adminFactory).not.toHaveBeenCalled();
  });
});
