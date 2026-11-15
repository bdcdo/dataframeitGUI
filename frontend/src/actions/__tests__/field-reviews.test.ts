import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { copyWithRef, loggedScope } from "@/test-utils/error-ref";
import {
  makeFilterAwareSupabaseMock,
  type RpcCall,
  type RpcResult,
  type WriteCall,
} from "@/test-utils/supabase-mock";

// Mock filter-aware: aplica os filtros da query às linhas de `tableData`, então
// cada linha declara as colunas que submitAutoReview/submitFinalVerdicts filtram
// (projeto, documento, revisor, árbitro, superseded_at). Uma linha de outro
// ciclo precisa ser descartada como o Postgres descartaria.
let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
// Faz uma RPC especifica falhar, por nome — usado para fixar o que sobrevive
// quando o fechamento da fila cai.
let rpcResults: Record<string, RpcResult>;
let tableData: Record<string, unknown[]>;
let projectAccessible: boolean;
let adminFactoryCalls: number;
let memberUserId: string;

const updateCallsOf = (table?: string) =>
  writeCalls.filter((c) => c.op === "update" && (!table || c.table === table));
const autoSubmitCall = () =>
  rpcCalls.find((call) => call.fn === "submit_auto_review_verdicts");

function makeClient() {
  return makeFilterAwareSupabaseMock({ tableData, writeCalls, rpcCalls, rpcResults });
}

// Linha de field_reviews do ciclo corrente da auto-revisão de user1 em doc1.
const autoReview = (overrides: Record<string, unknown> = {}) => ({
  id: "fr1",
  project_id: "p1",
  document_id: "doc1",
  self_reviewer_id: "user1",
  superseded_at: null,
  field_name: "q1",
  human_response_id: "hr1",
  llm_response_id: "lr1",
  ...overrides,
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// `after()` só existe dentro de uma request do Next: aqui ele guarda a tarefa
// para o teste conferir o que foi agendado e roda-la quando quiser.
const { afterTasks, propagateValueEquivalenceChange } = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  propagateValueEquivalenceChange: vi.fn(async () => {}),
}));
vi.mock("next/server", () => ({ after: (task: () => unknown) => { afterTasks.push(task); } }));
vi.mock("@/lib/value-equivalence-effects", () => ({ propagateValueEquivalenceChange }));
vi.mock("@/lib/auth", () => ({
  resolveProjectMemberActor: async () => ({
    ok: true,
    user: { id: "user1", isMaster: false },
    memberUserId,
  }),
  getProjectAccessContext: async () => ({
    status: "resolved",
    project: projectAccessible ? { id: "p1" } : null,
  }),
  requireCoordinator: async () => ({ ok: false, error: "não usado" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeClient(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => {
    adminFactoryCalls += 1;
    return makeClient();
  },
}));

beforeEach(() => {
  afterTasks.length = 0;
  propagateValueEquivalenceChange.mockClear();
  writeCalls = [];
  rpcCalls = [];
  rpcResults = {};
  projectAccessible = true;
  memberUserId = "user1";
  adminFactoryCalls = 0;
  tableData = {
    // O SELECT do ciclo lê os snapshots — testes de equivalente/ambíguo
    // sobrescrevem a linha conforme o caso.
    field_reviews: [
      autoReview({
        human_answer_snapshot: "Adalimumabe",
        llm_answer_snapshot: "adalimumabé",
      }),
    ],
  };
});

async function loadSubmit() {
  return (await import("@/actions/field-reviews")).submitAutoReview;
}

async function loadSubmitFinal() {
  return (await import("@/actions/field-reviews")).submitFinalVerdicts;
}

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/field-reviews");
}, 30_000);

describe("submitAutoReview — justificativa obrigatoria ao contestar o LLM", () => {
  it("sem acesso atual ao projeto → falha antes de usar o admin client", async () => {
    projectAccessible = false;
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "admite_erro" },
    ]);
    expect(r).toEqual({
      success: false,
      error: "Projeto não encontrado ou inacessível.",
    });
    expect(adminFactoryCalls).toBe(0);
    expect(writeCalls).toHaveLength(0);
  });

  it("usa a identidade canônica do membro na RPC", async () => {
    memberUserId = "canonical-reviewer";
    tableData.field_reviews = [autoReview({ self_reviewer_id: "canonical-reviewer" })];
    const submitAutoReview = await loadSubmit();

    const result = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "admite_erro" },
    ]);

    expect(result.success).toBe(true);
    expect(autoSubmitCall()?.args).toMatchObject({
      p_reviewer_id: "canonical-reviewer",
    });
  });

  // Cada filtro do SELECT do ciclo descarta uma linha que o Postgres também
  // descartaria: sem ele, o veredito seria gravado no ciclo errado.
  it.each([
    ["de outro projeto", { project_id: "p2" }],
    ["de outro documento", { document_id: "doc2" }],
    ["de outro auto-revisor", { self_reviewer_id: "user2" }],
    ["de ciclo substituído", { superseded_at: "2026-11-01T00:00:00Z" }],
  ])("linha %s não vale como ciclo corrente → nenhuma RPC", async (_, overrides) => {
    tableData.field_reviews = [autoReview(overrides)];
    const submitAutoReview = await loadSubmit();

    const result = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "admite_erro" },
    ]);

    expect(result).toEqual({
      success: false,
      error: 'Campo "q1": ciclo de revisão incompatível.',
    });
    expect(autoSubmitCall()).toBeUndefined();
  });

  it("contesta_llm sem justificativa → erro e nenhum UPDATE", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "contesta_llm" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("justificativa obrigatória");
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("contesta_llm com justificativa só de espaços → erro e nenhum UPDATE", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "contesta_llm", justification: "   \n\t" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("justificativa obrigatória");
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("admite_erro → passa na validacao e grava self_justification: null", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "admite_erro" },
    ]);
    expect(r.success).toBe(true);
    expect(autoSubmitCall()?.args).toMatchObject({
      p_rows: [{ verdict: "admite_erro", justification: null }],
    });
  });

  it("rejeita fieldReviewId de outro campo", async () => {
    const submitAutoReview = await loadSubmit();
    const result = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q2", verdict: "admite_erro" },
    ]);

    expect(result).toEqual({
      success: false,
      error: 'Campo "q2": ciclo de revisão incompatível.',
    });
  });

  it("contesta_llm com justificativa → grava o texto trimado", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "contesta_llm", justification: "  confere  " },
    ]);
    expect(r.success).toBe(true);
    expect(autoSubmitCall()?.args).toMatchObject({
      p_rows: [{ verdict: "contesta_llm", justification: "confere" }],
    });
  });

  it("retry de contesta_llm sem árbitro reenvia a linha à RPC, que é quem atribui", async () => {
    const submitAutoReview = await loadSubmit();
    tableData.field_reviews = [
      autoReview({ self_verdict: "contesta_llm", arbitrator_id: null }),
    ];

    const result = await submitAutoReview("p1", "doc1", [
      {
        fieldReviewId: "fr1",
        fieldName: "q1",
        verdict: "contesta_llm",
        justification: "discordo",
      },
    ]);

    expect(result.success).toBe(true);
    expect(autoSubmitCall()?.args).toMatchObject({
      p_rows: [{ field_review_id: "fr1", verdict: "contesta_llm" }],
    });
  });
});

describe("submitAutoReview — vereditos equivalente e ambiguo", () => {
  // A equivalência de valor vale no projeto inteiro: depois da resposta, os
  // outros documentos com os mesmos valores são reconciliados. Só o
  // 'equivalente' agenda, com o campo e os dois valores julgados.
  it("equivalente agenda a propagação com o campo e os dois snapshots; os demais vereditos não", async () => {
    const submitAutoReview = await loadSubmit();
    tableData.field_reviews = [
      autoReview({ id: "fr1", field_name: "q1",
        human_answer_snapshot: "NI", llm_answer_snapshot: "Não informado" }),
      autoReview({ id: "fr2", field_name: "q2",
        human_answer_snapshot: "a", llm_answer_snapshot: "b" }),
    ];
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "equivalente" },
      { fieldReviewId: "fr2", fieldName: "q2", verdict: "admite_erro" },
    ]);
    expect(r.success).toBe(true);
    expect(propagateValueEquivalenceChange).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]();
    expect(propagateValueEquivalenceChange).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      changes: [{ fieldName: "q1", values: ["NI", "Não informado"] }],
    });
  });

  // Vários 'equivalente' no mesmo envio: uma propagação só, com uma mudança
  // por campo — e não uma drenagem por campo concorrendo entre si.
  it("vários equivalente no mesmo envio agendam uma propagação só", async () => {
    const submitAutoReview = await loadSubmit();
    tableData.field_reviews = [
      autoReview({ id: "fr1", field_name: "q1",
        human_answer_snapshot: "NI", llm_answer_snapshot: "Não informado" }),
      autoReview({ id: "fr2", field_name: "q2",
        human_answer_snapshot: "a", llm_answer_snapshot: "A." }),
    ];
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "equivalente" },
      { fieldReviewId: "fr2", fieldName: "q2", verdict: "equivalente" },
    ]);
    expect(r.success).toBe(true);
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]();
    expect(propagateValueEquivalenceChange).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      changes: [
        { fieldName: "q1", values: ["NI", "Não informado"] },
        { fieldName: "q2", values: ["a", "A."] },
      ],
    });
  });

  it("submit que falha na RPC não agenda propagação", async () => {
    const submitAutoReview = await loadSubmit();
    rpcResults.submit_auto_review_verdicts = { error: { message: "boom" } };
    tableData.field_reviews = [
      autoReview({ id: "fr1", field_name: "q1",
        human_answer_snapshot: "NI", llm_answer_snapshot: "Não informado" }),
    ];
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "equivalente" },
    ]);
    expect(r.success).toBe(false);
    expect(afterTasks).toHaveLength(0);
  });

  it("equivalente → registra a equivalência pela RPC idempotente", async () => {
    const submitAutoReview = await loadSubmit();
    tableData.field_reviews = [
      autoReview({
        self_verdict: "equivalente",
      }),
    ];
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "equivalente" },
    ]);
    expect(r.success).toBe(true);

    expect(autoSubmitCall()?.args).toMatchObject({
      p_rows: [{ field_review_id: "fr1", verdict: "equivalente" }],
    });
  });

  it("ambiguo sem justificativa → erro e nenhum UPDATE", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "ambiguo" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("justificativa obrigatória");
    expect(r.error).toContain("ambíguo");
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("ambiguo com justificativa só de espaços → erro e nenhum UPDATE", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "ambiguo", justification: "   \n\t" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("justificativa obrigatória");
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("ambiguo → grava self_justification trimada e insere project_comments com o contraste e a justificativa", async () => {
    const submitAutoReview = await loadSubmit();
    tableData.field_reviews = [
      autoReview({
        human_answer_snapshot: "Adalimumabe",
        llm_answer_snapshot: "adalimumabé",
        self_verdict: "ambiguo",
      }),
    ];
    const r = await submitAutoReview("p1", "doc1", [
      {
        fieldReviewId: "fr1",
        fieldName: "q1",
        verdict: "ambiguo",
        justification: "  o enunciado não define a unidade  ",
      },
    ]);
    expect(r.success).toBe(true);

    const rows = (autoSubmitCall()?.args as { p_rows: Array<Record<string, unknown>> }).p_rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field_name: "q1", field_review_id: "fr1", verdict: "ambiguo",
      justification: "o enunciado não define a unidade",
    });
    expect(String(rows[0].comment_body)).toContain("ambíguo");
    expect(String(rows[0].comment_body)).toContain("Adalimumabe");
    expect(String(rows[0].comment_body)).toContain(
      "Justificativa do pesquisador: o enunciado não define a unidade",
    );
  });

  it("equivalente em retry reenvia a linha à RPC, dona da idempotência", async () => {
    const submitAutoReview = await loadSubmit();
    // Cenario de retry: um call anterior ja gravou self_verdict='equivalente'.
    // A idempotencia e da RPC; o TS reenvia a linha mesmo assim.
    tableData.field_reviews = [
      autoReview({
        self_verdict: "equivalente",
      }),
    ];
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "equivalente" },
    ]);
    expect(r.success).toBe(true);

    expect(autoSubmitCall()?.args).toMatchObject({ p_rows: [
      { field_name: "q1", field_review_id: "fr1", verdict: "equivalente" },
    ] });
  });
});

describe("submitAutoReview — conclusão do assignment", () => {
  // O fechamento da projeção temporária acontece na mesma RPC que persiste os
  // vereditos. O TypeScript não mantém um segundo caminho de escrita.
  it("delega o fechamento à RPC, sem escrever em assignments", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "admite_erro" },
    ]);
    expect(r.success).toBe(true);

    expect(autoSubmitCall()).toBeDefined();
    expect(updateCallsOf("assignments")).toHaveLength(0);
  });

  // O texto do Postgres ia cru, em inglês, ao toast pt-BR: vai ao log (#502).
  it("falha da RPC atômica é reportada sem escritas parciais no cliente", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcResults.submit_auto_review_verdicts = { error: { message: "lock timeout" } };
    const submitAutoReview = await loadSubmit();

    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "contesta_llm", justification: "discordo" },
    ]);

    expect(r).toEqual({
      success: false,
      error: copyWithRef("Não foi possível enviar a auto-revisão. Tente novamente."),
    });
    expect(updateCallsOf()).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith(
      loggedScope("[field-reviews] envio da auto-revisão falhou"),
      expect.objectContaining({ message: "lock timeout" }),
    );
    consoleError.mockRestore();
  });
});

describe("submitFinalVerdicts — service role somente após os gates", () => {
  const finalReview = (overrides: Record<string, unknown> = {}) => ({
    id: "fr1",
    project_id: "p1",
    document_id: "doc1",
    arbitrator_id: "user1",
    superseded_at: null,
    field_name: "q1",
    human_response_id: "hr1",
    llm_response_id: "lr1",
    blind_verdict: "humano",
    final_verdict: null,
    ...overrides,
  });

  it("linha ausente/RLS falha antes de criar o admin client", async () => {
    tableData.field_reviews = [];
    const submitFinalVerdicts = await loadSubmitFinal();
    const result = await submitFinalVerdicts("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "humano" },
    ]);

    expect(result).toEqual({
      success: false,
      error: 'Campo "q1": linha de revisão não encontrada ou sem permissão.',
    });
    expect(adminFactoryCalls).toBe(0);
  });

  it.each([
    ["de outro projeto", { project_id: "p2" }],
    ["de outro documento", { document_id: "doc2" }],
    ["de outro árbitro", { arbitrator_id: "user2" }],
    ["de ciclo substituído", { superseded_at: "2026-11-01T00:00:00Z" }],
  ])("linha %s falha antes de criar o admin client", async (_, overrides) => {
    tableData.field_reviews = [finalReview(overrides)];
    const submitFinalVerdicts = await loadSubmitFinal();
    const result = await submitFinalVerdicts("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "humano" },
    ]);

    expect(result).toEqual({
      success: false,
      error: 'Campo "q1": linha de revisão não encontrada ou sem permissão.',
    });
    expect(adminFactoryCalls).toBe(0);
  });

  it("fase cega pendente falha antes de criar o admin client", async () => {
    tableData.field_reviews = [finalReview({ blind_verdict: null })];
    const submitFinalVerdicts = await loadSubmitFinal();
    const result = await submitFinalVerdicts("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "humano" },
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("fase cega ainda não decidida");
    expect(adminFactoryCalls).toBe(0);
  });

  it("decisão humana válida usa a RPC atômica após os gates", async () => {
    tableData.field_reviews = [finalReview()];
    const submitFinalVerdicts = await loadSubmitFinal();
    const result = await submitFinalVerdicts("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "humano" },
    ]);

    expect(result.success).toBe(true);
    expect(adminFactoryCalls).toBe(1);
    expect(rpcCalls.some((call) => call.fn === "submit_final_review_verdicts")).toBe(true);
  });

  it("decisão LLM cria o admin client uma vez, depois dos gates", async () => {
    tableData.field_reviews = [finalReview()];
    const submitFinalVerdicts = await loadSubmitFinal();
    const result = await submitFinalVerdicts("p1", "doc1", [
      {
        fieldReviewId: "fr1",
        fieldName: "q1",
        verdict: "llm",
        questionImprovementSuggestion: "Clarificar a pergunta",
      },
    ]);

    expect(result.success).toBe(true);
    expect(adminFactoryCalls).toBe(1);
  });
});
