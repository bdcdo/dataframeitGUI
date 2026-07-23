import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock minimo do supabase: captura os payloads de .update()/.upsert()/.insert()
// para validar o que submitAutoReview enviaria ao DB sem subir Postgres.
// Builder chainable e thenable — `await builder` (ou apos .select()) resolve
// { data, error }.
type WriteCall = { table: string; op: string; payload: unknown };
type RpcCall = { fn: string; args: unknown };
let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
// Faz uma RPC especifica falhar, por nome — usado para fixar o que sobrevive
// quando o fechamento da fila cai.
let rpcErrors: Record<string, string>;
let tableData: Record<string, unknown>;
let projectAccessible: boolean;
let adminFactoryCalls: number;
let memberUserId: string;

const updateCallsOf = (table?: string) =>
  writeCalls.filter((c) => c.op === "update" && (!table || c.table === table));
const autoSubmitCall = () =>
  rpcCalls.find((call) => call.fn === "submit_auto_review_verdicts");

function makeClient() {
  return {
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      const message = rpcErrors[fn];
      return { data: null, error: message ? { message } : null };
    },
    from: (table: string) => {
      // `limited` distingue a query de "ainda há campo pendente?" (usa .limit)
      // do UPDATE de field_reviews (usa .select) — ambos batem na mesma tabela.
      let limited = false;
      const builder: Record<string, unknown> = {};
      let op = "select";
      for (const m of ["select", "eq", "is", "in", "neq", "not"]) {
        builder[m] = () => builder;
      }
      builder.limit = () => {
        limited = true;
        return builder;
      };
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
      builder.then = (resolve: (v: unknown) => unknown) => {
        // A query "ainda ha field_review pendente?" usa .limit em
        // field_reviews — resolve para a fixture dedicada.
        if (table === "field_reviews" && limited) {
          return resolve({
            data: tableData.field_reviews_pending ?? null,
            error: null,
          });
        }
        // Resolve por operacao quando ha override `${table}:${op}` — permite um
        // teste fazer o UPDATE casar 0 linhas mas o SELECT de estado ver a linha
        // (cenario de retry apos falha parcial). Senao cai no dado generico.
        return resolve({
          data: tableData[`${table}:${op}`] ?? tableData[table] ?? null,
          error: null,
        });
      };
      return builder;
    },
  };
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
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
  writeCalls = [];
  rpcCalls = [];
  rpcErrors = {};
  projectAccessible = true;
  memberUserId = "user1";
  adminFactoryCalls = 0;
  tableData = {
    // UPDATE de field_reviews retorna a linha tocada (via .select). O SELECT de
    // estado real (efeitos de equivalente/ambiguo) le esta mesma linha — testes
    // desses vereditos sobrescrevem `self_verdict` conforme o caso.
    field_reviews: [
      {
        id: "fr1",
        field_name: "q1",
        human_response_id: "hr1",
        llm_response_id: "lr1",
        human_answer_snapshot: "Adalimumabe",
        llm_answer_snapshot: "adalimumabé",
      },
    ],
    // Consumida pelo `.limit(1)` de syncArbitragemAssignmentStatus, que ainda
    // decide o fechamento da ARBITRAGEM no TypeScript (a auto-revisão decide na
    // RPC). Vazia = nada pendente, o caminho que não explode.
    field_reviews_pending: [],
    responses: [],
    // sem comentarios pre-existentes → check-before-insert nao suprime nada
    project_comments: [],
    // pool de arbitragem vazio → assignArbitrator curto-circuita sem erro
    project_members: [],
  };
});

async function loadSubmit() {
  return (await import("@/actions/field-reviews")).submitAutoReview;
}

async function loadSubmitFinal() {
  return (await import("@/actions/field-reviews")).submitFinalVerdicts;
}

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
    const submitAutoReview = await loadSubmit();

    const result = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "admite_erro" },
    ]);

    expect(result.success).toBe(true);
    expect(autoSubmitCall()?.args).toMatchObject({
      p_reviewer_id: "canonical-reviewer",
    });
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

  it("retry de contesta_llm sem árbitro repete apenas a atribuição", async () => {
    const submitAutoReview = await loadSubmit();
    tableData["field_reviews:update"] = [];
    tableData.field_reviews = [
      {
        id: "fr1",
        field_name: "q1",
        self_verdict: "contesta_llm",
        arbitrator_id: null,
      },
    ];
    tableData.project_members = [{ user_id: "arb1", role: "pesquisador" }];

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
  it("equivalente → registra o par canonico pela RPC idempotente", async () => {
    const submitAutoReview = await loadSubmit();
    tableData.field_reviews = [
      {
        id: "fr1",
        field_name: "q1",
        human_response_id: "hr1",
        llm_response_id: "lr1",
        self_verdict: "equivalente",
      },
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
      {
        id: "fr1",
        field_name: "q1",
        human_response_id: "hr1",
        llm_response_id: "lr1",
        human_answer_snapshot: "Adalimumabe",
        llm_answer_snapshot: "adalimumabé",
        self_verdict: "ambiguo",
      },
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

  it("equivalente em retry (UPDATE casa 0 linhas) ainda registra a equivalencia", async () => {
    const submitAutoReview = await loadSubmit();
    // Cenario de retry: um call anterior gravou self_verdict='equivalente' mas
    // falhou no upsert de response_equivalences. Agora o UPDATE casa 0 linhas
    // (self_verdict ja nao e NULL), mas o estado real mostra o campo resolvido.
    tableData["field_reviews:update"] = [];
    tableData.field_reviews = [
      {
        id: "fr1",
        field_name: "q1",
        human_response_id: "hr1",
        llm_response_id: "lr1",
        self_verdict: "equivalente",
      },
    ];
    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "equivalente" },
    ]);
    expect(r.success).toBe(true);

    // Apesar do UPDATE nao ter casado, o efeito colateral roda (idempotente).
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

  it("falha da RPC atômica é reportada sem escritas parciais no cliente", async () => {
    rpcErrors.submit_auto_review_verdicts = "lock timeout";
    tableData.project_members = [{ user_id: "arb1", role: "pesquisador" }];
    const submitAutoReview = await loadSubmit();

    const r = await submitAutoReview("p1", "doc1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "contesta_llm", justification: "discordo" },
    ]);

    expect(r).toEqual({ success: false, error: "lock timeout" });
    expect(updateCallsOf()).toHaveLength(0);
  });
});

describe("submitFinalVerdicts — service role somente após os gates", () => {
  const finalReview = (overrides: Record<string, unknown> = {}) => ({
    id: "fr1",
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
