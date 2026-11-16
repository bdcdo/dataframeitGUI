import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";
import {
  makeSupabaseAdminModuleMock,
  makeSupabaseServerModuleMock,
  makeFilterAwareSupabaseMock,
  type RpcCall,
  type QueryError,
  type RpcResult,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { authModuleMock } from "@/test-utils/auth-mock";

// Mock supabase chainable filter-aware: aplica os .eq/.is/.in/.neq das
// queries às linhas de `tableData`, então cada linha carrega as colunas que a
// action filtra (project_id, self_verdict, can_arbitrate...). Captura a RPC
// que faz o commit atômico de retryPendingArbitrations/assignArbitrator sem
// subir Postgres.
let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let rpcResults: Record<string, RpcResult>;
let tableData: Record<string, unknown[]>;
let queryErrors: Record<string, QueryError | null>;

// Linhas que satisfazem os filtros da action para o projeto "p1"; `over`
// ajusta só o que o cenário quer variar.
const pendingReview = (
  id: string,
  documentId: string,
  selfReviewerId: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  project_id: "p1",
  document_id: documentId,
  self_reviewer_id: selfReviewerId,
  self_verdict: "contesta_llm",
  superseded_at: null,
  arbitrator_id: null,
  ...over,
});
const arbiter = (
  userId: string,
  over: Record<string, unknown> = {},
) => ({
  project_id: "p1",
  user_id: userId,
  role: "pesquisador",
  can_arbitrate: true,
  ...over,
});
const humanResponse = (
  documentId: string,
  respondentId: string,
  over: Record<string, unknown> = {},
) => ({
  project_id: "p1",
  document_id: documentId,
  respondent_id: respondentId,
  respondent_type: "humano",
  ...over,
});
const openArbitration = (
  userId: string,
  over: Record<string, unknown> = {},
) => ({
  project_id: "p1",
  user_id: userId,
  type: "arbitragem",
  status: "pendente",
  ...over,
});

const arbitrationCalls = () =>
  rpcCalls.filter((call) => call.fn === "assign_arbitration_cycles_if_eligible");

function makeClient() {
  return makeFilterAwareSupabaseMock({
    tableData,
    writeCalls,
    rpcCalls,
    rpcResults,
    queryErrors,
  });
}

// isProjectCoordinator: hoisted para permitir override por teste.
const hoisted = vi.hoisted(() => ({
  isCoord: vi.fn<() => Promise<boolean>>(async () => true),
  adminFactory: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => authModuleMock(hoisted.isCoord));
vi.mock("@/lib/supabase/server", () => makeSupabaseServerModuleMock(makeClient));
vi.mock("@/lib/supabase/admin", () =>
  makeSupabaseAdminModuleMock(makeClient, hoisted.adminFactory),
);

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  rpcResults = {
    assign_arbitration_cycles_if_eligible: { data: 1 },
  };
  queryErrors = {};
  tableData = {
    field_reviews: [],
    project_members: [],
    assignments: [],
    responses: [],
  };
  hoisted.isCoord.mockResolvedValue(true);
  hoisted.adminFactory.mockClear();
});

async function loadRetry() {
  return (await import("@/actions/field-reviews")).retryPendingArbitrations;
}

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/field-reviews");
}, 30_000);

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

  it("sem field_reviews pendentes → assigned 0 e nenhuma RPC", async () => {
    tableData.field_reviews = [];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(0);
    expect(arbitrationCalls()).toHaveLength(0);
  });
});

describe("retryPendingArbitrations — agrupamento por (document_id, self_reviewer_id)", () => {
  it("dois fields do mesmo doc/self_reviewer → 1 commit atômico", async () => {
    tableData.field_reviews = [
      pendingReview("fr1", "doc1", "userA"),
      pendingReview("fr2", "doc1", "userA"),
    ];
    // Pool com 1 árbitro elegível (assignArbitrator pode sortear)
    tableData.project_members = [
      arbiter("userB"),
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(arbitrationCalls()).toHaveLength(1);
    expect(arbitrationCalls()[0].args).toEqual({
      p_project_id: "p1",
      p_document_id: "doc1",
      p_user_id: "userB",
      p_field_review_ids: ["fr1", "fr2"],
    });
    expect(writeCalls).toHaveLength(0);
  });

  it("dois docs distintos → 2 commits atômicos", async () => {
    tableData.field_reviews = [
      pendingReview("fr1", "doc1", "userA"),
      pendingReview("fr2", "doc2", "userC"),
    ];
    tableData.project_members = [
      arbiter("userB"),
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(arbitrationCalls()).toHaveLength(2);
    expect(writeCalls).toHaveLength(0);
  });

  it("self_reviewers diferentes no mesmo doc → 2 grupos (caso raro mas suportado)", async () => {
    tableData.field_reviews = [
      pendingReview("fr1", "doc1", "userA"),
      pendingReview("fr2", "doc1", "userC"),
    ];
    tableData.project_members = [
      arbiter("userB"),
    ];
    const retry = await loadRetry();
    await retry("p1");
    expect(arbitrationCalls()).toHaveLength(2);
  });
});

describe("retryPendingArbitrations — pool vazio", () => {
  it("nenhum membro elegível → stillNoPool incrementa, sem UPDATE", async () => {
    tableData.field_reviews = [
      pendingReview("fr1", "doc1", "userA"),
    ];
    tableData.project_members = [];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(1);
    expect(arbitrationCalls()).toHaveLength(0);
  });

  it("candidato desabilitado antes do commit → RPC não grava", async () => {
    tableData.field_reviews = [
      pendingReview("fr1", "doc1", "userA"),
    ];
    tableData.project_members = [
      arbiter("userB"),
    ];
    rpcResults.assign_arbitration_cycles_if_eligible = { data: 0 };

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
      pendingReview("fr1", "doc1", "userA"),
    ];
    tableData.project_members = [
      arbiter("userB"),
      arbiter("userC"),
    ];
    // userB deu resposta humana em doc1 → não pode arbitrar (juiz em causa própria)
    tableData.responses = [humanResponse("doc1", "userB")];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(arbitrationCalls()).toHaveLength(1);
    expect(arbitrationCalls()[0].args).toMatchObject({ p_user_id: "userC" });
  });

  it("todos os elegíveis codificaram o doc → fallback para elegível != auto-revisor", async () => {
    tableData.field_reviews = [
      pendingReview("fr1", "doc1", "userA"),
    ];
    tableData.project_members = [
      arbiter("userB"),
      arbiter("userC"),
    ];
    // Doc codificado por toda a equipe elegível (caso de calibração): nenhum
    // árbitro totalmente neutro, mas userB/userC não são o auto-revisor userA.
    tableData.responses = [
      humanResponse("doc1", "userB"),
      humanResponse("doc1", "userC"),
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(1);
    expect(r.stillNoPool).toBe(0);
    expect(arbitrationCalls()).toHaveLength(1);
    const args = arbitrationCalls()[0].args as { p_user_id: string };
    expect(["userB", "userC"]).toContain(args.p_user_id);
  });

  it("único elegível é o próprio auto-revisor → stillNoPool, sem UPDATE", async () => {
    tableData.field_reviews = [
      pendingReview("fr1", "doc1", "userA"),
    ];
    tableData.project_members = [arbiter("userA")];
    tableData.responses = [humanResponse("doc1", "userA")];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(1);
    expect(arbitrationCalls()).toHaveLength(0);
  });
});

describe("retryPendingArbitrations — erro na pré-busca de codificadores", () => {
  it("falha na leitura dos codificadores → erro, sem atribuir codificador como árbitro neutro", async () => {
    tableData.field_reviews = [pendingReview("fr1", "doc1", "userA")];
    tableData.project_members = [arbiter("userB")];
    // A leitura falha sem linhas, como no PostgREST: sem o set, userB (que
    // pode ter codificado o doc) pareceria neutro.
    queryErrors = { "responses:select": { message: "timeout", code: "57014" } };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(false);
    // O texto do Postgres vai ao log, e o toast recebe copy pt-BR (#502).
    expect(r.error).toEqual(
      copyWithRef("Não foi possível redistribuir as arbitragens pendentes. Tente novamente."),
    );
    expect(arbitrationCalls()).toHaveLength(0);
    consoleError.mockRestore();
  });
});

describe("retryPendingArbitrations — erro na RPC de atribuição", () => {
  // assignArbitrator lança o erro do PostgREST, e o catch da action o converte:
  // o texto em inglês e o code vão ao log, o toast recebe a copy pt-BR.
  it("vira a copy pt-BR com código, e o log leva o code do Postgres", async () => {
    tableData.field_reviews = [pendingReview("fr1", "doc1", "userA")];
    tableData.project_members = [arbiter("userB")];
    rpcResults.assign_arbitration_cycles_if_eligible = {
      error: { message: "deadlock detected", code: "40P01" },
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r).toEqual({
      success: false,
      error: copyWithRef("Não foi possível redistribuir as arbitragens pendentes. Tente novamente."),
      assigned: 0,
      stillNoPool: 0,
    });
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[field-reviews] redistribuição das arbitragens falhou", {
        code: "40P01",
        message: "deadlock detected",
      }),
    );
    consoleError.mockRestore();
  });
});

describe("retryPendingArbitrations — batch de responses agrupado por doc", () => {
  it("dois docs com codificadores distintos → cada assignArbitrator vê só o seu doc", async () => {
    tableData.field_reviews = [
      pendingReview("fr1", "doc1", "userA"),
      pendingReview("fr2", "doc2", "userA"),
    ];
    tableData.project_members = [
      arbiter("userB"),
      arbiter("userC"),
    ];
    // userB codificou doc1; userC codificou doc2. Pool por doc deve excluir
    // só o codificador daquele doc — não confundir entre docs.
    tableData.responses = [
      humanResponse("doc1", "userB"),
      humanResponse("doc2", "userC"),
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

// Cada caso abaixo põe na tabela uma linha que a query da action precisa
// descartar pelo filtro. Com o mock antigo, que ignorava filtros (#686), todos
// passavam mesmo se a action esquecesse o .eq/.is/.neq correspondente. O
// .in("document_id") da pré-busca de responses fica sem caso: a action agrupa
// por document_id em código, então sem ele o resultado é o mesmo (só lê mais).
describe("retryPendingArbitrations — filtros das queries", () => {
  it.each([
    ["já tem árbitro", { arbitrator_id: "userX" }],
    ["foi substituído", { superseded_at: "2026-01-01T00:00:00Z" }],
    ["auto-revisor admitiu o erro", { self_verdict: "admite_erro" }],
    ["é de outro projeto", { project_id: "p2" }],
  ])("field_review que %s não é reprocessado", async (_caso, over) => {
    tableData.field_reviews = [pendingReview("fr1", "doc1", "userA", over)];
    tableData.project_members = [arbiter("userB")];
    const retry = await loadRetry();
    expect(await retry("p1")).toEqual({
      success: true,
      assigned: 0,
      stillNoPool: 0,
    });
    expect(arbitrationCalls()).toHaveLength(0);
  });

  it.each([
    ["sem can_arbitrate", { can_arbitrate: false }],
    ["de outro projeto", { project_id: "p2" }],
  ])("membro %s fica fora do pool", async (_caso, over) => {
    tableData.field_reviews = [pendingReview("fr1", "doc1", "userA")];
    tableData.project_members = [arbiter("userB", over)];
    const retry = await loadRetry();
    expect(await retry("p1")).toMatchObject({ assigned: 0, stillNoPool: 1 });
    expect(arbitrationCalls()).toHaveLength(0);
  });

  it.each([
    ["do LLM", { respondent_type: "llm" }],
    ["de outro projeto", { project_id: "p2" }],
  ])("resposta %s não tira o membro do pool neutro", async (_caso, over) => {
    tableData.field_reviews = [pendingReview("fr1", "doc1", "userA")];
    tableData.project_members = [arbiter("userB"), arbiter("userC")];
    // Só a resposta humana de userC neste projeto conta como codificação; a
    // de userB, descartada pelo filtro, não o torna codificador do doc.
    tableData.responses = [
      humanResponse("doc1", "userC"),
      humanResponse("doc1", "userB", over),
    ];
    // userB carrega uma arbitragem aberta: se a resposta descartada contasse,
    // os dois seriam codificadores, o pool cairia no fallback e a menor carga
    // (userC) venceria — o caso reprova de forma determinística, sem sorteio.
    tableData.assignments = [openArbitration("userB")];
    const retry = await loadRetry();
    await retry("p1");
    expect(arbitrationCalls()).toHaveLength(1);
    expect(arbitrationCalls()[0].args).toMatchObject({ p_user_id: "userB" });
  });

  it.each([
    ["concluídas", { status: "concluido" }],
    ["de outro tipo", { type: "codificacao" }],
    ["de outro projeto", { project_id: "p2" }],
  ])("atribuições %s não contam como carga de arbitragem", async (_caso, over) => {
    tableData.field_reviews = [pendingReview("fr1", "doc1", "userA")];
    tableData.project_members = [arbiter("userB"), arbiter("userC")];
    // userB tem 1 arbitragem aberta; userC tem 2 linhas que o filtro descarta.
    // Com o filtro, userC (carga 0) vence; sem ele, userC teria carga 2.
    tableData.assignments = [
      openArbitration("userB"),
      openArbitration("userC", over),
      openArbitration("userC", over),
    ];
    const retry = await loadRetry();
    await retry("p1");
    expect(arbitrationCalls()).toHaveLength(1);
    expect(arbitrationCalls()[0].args).toMatchObject({ p_user_id: "userC" });
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
    expect(hoisted.adminFactory).not.toHaveBeenCalled();
  });
});
