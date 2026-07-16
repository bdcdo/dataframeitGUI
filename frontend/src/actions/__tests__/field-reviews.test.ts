import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock minimo do supabase: captura os payloads de .update()/.upsert()/.insert()
// para validar o que submitAutoReview enviaria ao DB sem subir Postgres.
// Builder chainable e thenable — `await builder` (ou apos .select()) resolve
// { data, error }.
type WriteCall = { table: string; op: string; payload: unknown };
type RpcCall = { fn: string; args: unknown };
type FilterCall = {
  table: string;
  method: "eq" | "is" | "in" | "neq" | "not";
  column: string;
  value: unknown;
};
let writeCalls: WriteCall[];
let filterCalls: FilterCall[];
let rpcCalls: RpcCall[];
let tableData: Record<string, unknown>;
let adminClientCreations: number;

const updateCallsOf = (table?: string) =>
  writeCalls.filter((c) => c.op === "update" && (!table || c.table === table));

const writeCallOf = (op: string, table: string) =>
  writeCalls.find((call) => call.op === op && call.table === table);

function fieldReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "fr1",
    field_name: "q1",
    human_response_id: "hr1",
    llm_response_id: "lr1",
    self_verdict: null,
    self_justification: null,
    arbitrator_id: null,
    blind_verdict: "humano",
    final_verdict: null,
    ...overrides,
  };
}

function setFieldReview(overrides: Record<string, unknown> = {}) {
  tableData.field_reviews = [fieldReview(overrides)];
}

function applyFieldReviewUpdate(
  table: string,
  operation: string,
  updatePayload: Record<string, unknown> | null,
) {
  if (table !== "field_reviews" || operation !== "update") return;

  const explicitUpdateResult = tableData["field_reviews:update"];
  if (
    explicitUpdateResult === undefined &&
    Array.isArray(tableData.field_reviews) &&
    updatePayload
  ) {
    tableData.field_reviews = tableData.field_reviews.map((row) => ({
      ...(row as Record<string, unknown>),
      ...updatePayload,
    }));
    return;
  }

  const stateAfterEmptyUpdate = tableData["field_reviews:after-empty-update"];
  if (
    explicitUpdateResult !== undefined &&
    stateAfterEmptyUpdate !== undefined
  ) {
    tableData.field_reviews = stateAfterEmptyUpdate;
  }
}

function queryResult(table: string, operation: string, limited: boolean) {
  // A query "ainda ha field_review pendente?" usa .limit em
  // field_reviews — resolve para a fixture dedicada.
  if (table === "field_reviews" && limited) {
    return {
      data: tableData.field_reviews_pending ?? null,
      error: tableData["__error:field_reviews:select"] ?? null,
    };
  }

  // Resolve por operacao quando ha override `${table}:${operation}` — permite
  // um teste fazer o UPDATE casar 0 linhas mas o SELECT de estado ver a linha
  // (cenario de retry apos falha parcial). Senao cai no dado generico.
  return {
    data: tableData[`${table}:${operation}`] ?? tableData[table] ?? null,
    error: tableData[`__error:${table}:${operation}`] ?? null,
  };
}

function makeClient() {
  return {
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      const result = tableData[`__rpc:${fn}`] as
        { data?: unknown; error?: unknown } | undefined;
      return { data: result?.data ?? 1, error: result?.error ?? null };
    },
    from: (table: string) => {
      // `limited` distingue a query de "ainda há campo pendente?" (usa .limit)
      // do UPDATE de field_reviews (usa .select) — ambos batem na mesma tabela.
      let limited = false;
      const builder: Record<string, unknown> = {};
      let op = "select";
      let updatePayload: Record<string, unknown> | null = null;
      builder.select = () => builder;
      for (const method of ["eq", "is", "in", "neq", "not"] as const) {
        builder[method] = (column: string, ...values: unknown[]) => {
          filterCalls.push({
            table,
            method,
            column,
            value: values.at(-1),
          });
          return builder;
        };
      }
      builder.limit = () => {
        limited = true;
        return builder;
      };
      builder.update = (payload: unknown) => {
        writeCalls.push({ table, op: "update", payload });
        updatePayload = payload as Record<string, unknown>;
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
        applyFieldReviewUpdate(table, op, updatePayload);
        return resolve(queryResult(table, op, limited));
      };
      return builder;
    },
  };
}

const auth = vi.hoisted(() => {
  const getAuthUser = vi.fn(async () => ({ id: "user1" }));
  const resolveMemberUserId = vi.fn<(projectId: string) => Promise<string>>(
    async () => "user1",
  );
  return {
    getAuthUser,
    resolveMemberUserId,
    resolveProjectMemberActor: vi.fn(async (projectId: string) => {
      const user = await getAuthUser();
      if (!user) {
        return {
          ok: false,
          code: "unauthenticated",
          error: "Não autenticado",
        };
      }
      try {
        return {
          ok: true,
          user,
          memberUserId: await resolveMemberUserId(projectId),
        };
      } catch {
        return {
          ok: false,
          code: "identity_unavailable",
          error: "Não foi possível verificar sua identidade no projeto.",
        };
      }
    }),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeClient(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => {
    adminClientCreations += 1;
    return makeClient();
  },
}));

beforeEach(() => {
  writeCalls = [];
  filterCalls = [];
  rpcCalls = [];
  adminClientCreations = 0;
  auth.getAuthUser.mockResolvedValue({ id: "user1" });
  auth.resolveMemberUserId.mockResolvedValue("user1");
  tableData = {
    // UPDATE de field_reviews retorna a linha tocada (via .select). O SELECT de
    // estado real (efeitos de equivalente/ambiguo) le esta mesma linha — testes
    // desses vereditos sobrescrevem `self_verdict` conforme o caso.
    field_reviews: [fieldReview()],
    // por padrão não sobra campo pendente → assignment é concluído
    field_reviews_pending: [],
    // respostas para o contexto do comentario de "ambiguo"
    responses: [
      { id: "hr1", answers: { q1: "Adalimumabe" } },
      { id: "lr1", answers: { q1: "adalimumabé" } },
    ],
    // sem comentarios pre-existentes → check-before-insert nao suprime nada
    project_comments: [],
    // pool de arbitragem vazio → assignArbitrator curto-circuita sem erro
    project_members: [],
  };
});

async function submitAutoReview(choice: {
  fieldName: string;
  verdict: "admite_erro" | "contesta_llm" | "equivalente" | "ambiguo";
  justification?: string;
}) {
  const action = (await import("@/actions/field-reviews")).submitAutoReview;
  return action("p1", "doc1", [choice]);
}

async function submitFinalVerdict(choice: {
  fieldName: string;
  verdict: "humano" | "llm";
  questionImprovementSuggestion?: string;
  arbitratorComment?: string;
}) {
  const action = (await import("@/actions/field-reviews")).submitFinalVerdicts;
  return action("p1", "doc1", [choice]);
}

describe("submitAutoReview — validação da justificativa", () => {
  const invalidCases: Array<{
    label: string;
    verdict: "contesta_llm" | "ambiguo";
    justification?: string;
    expectedDetail: string;
  }> = [
    {
      label: "contestação sem justificativa",
      verdict: "contesta_llm",
      expectedDetail: "contesta",
    },
    {
      label: "contestação com justificativa vazia",
      verdict: "contesta_llm",
      justification: "   \n\t",
      expectedDetail: "contesta",
    },
    {
      label: "campo ambíguo sem justificativa",
      verdict: "ambiguo",
      expectedDetail: "ambíguo",
    },
    {
      label: "campo ambíguo com justificativa vazia",
      verdict: "ambiguo",
      justification: "   \n\t",
      expectedDetail: "ambíguo",
    },
  ];

  it.each(invalidCases)("$label → erro e nenhum UPDATE", async (testCase) => {
    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: testCase.verdict,
      justification: testCase.justification,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("justificativa obrigatória");
    expect(result.error).toContain(testCase.expectedDetail);
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("rejeita o mesmo campo duas vezes antes de qualquer escrita", async () => {
    const action = (await import("@/actions/field-reviews")).submitAutoReview;
    const result = await action("p1", "doc1", [
      { fieldName: "q1", verdict: "admite_erro" },
      {
        fieldName: "q1",
        verdict: "contesta_llm",
        justification: "resposta correta",
      },
    ]);

    expect(result).toEqual({
      success: false,
      error: 'Campo "q1" enviado mais de uma vez.',
    });
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("admite_erro grava self_justification nula", async () => {
    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "admite_erro",
    });

    expect(result.success).toBe(true);
    const frUpdate = updateCallsOf("field_reviews")[0];
    expect(frUpdate?.payload).toMatchObject({
      self_verdict: "admite_erro",
      self_justification: null,
    });
  });

  it("contesta_llm grava a justificativa trimada", async () => {
    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "contesta_llm",
      justification: "  confere  ",
    });

    expect(result.success).toBe(true);
    const frUpdate = updateCallsOf("field_reviews")[0];
    expect(frUpdate?.payload).toMatchObject({
      self_verdict: "contesta_llm",
      self_justification: "confere",
    });
  });
});

describe("submitAutoReview — vereditos equivalente e ambiguo", () => {
  it("equivalente → faz upsert do par canonico em response_equivalences", async () => {
    setFieldReview({ self_verdict: "equivalente" });
    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "equivalente",
    });

    expect(result.success).toBe(true);

    const frUpdate = updateCallsOf("field_reviews")[0];
    expect(frUpdate?.payload).toMatchObject({
      self_verdict: "equivalente",
      self_justification: null,
    });

    const equivalence = writeCallOf("upsert", "response_equivalences");
    // canonicalPair("hr1", "lr1") → ["hr1", "lr1"] (hr1 < lr1)
    expect(equivalence?.payload).toMatchObject([
      {
        project_id: "p1",
        document_id: "doc1",
        field_name: "q1",
        response_a_id: "hr1",
        response_b_id: "lr1",
        reviewer_id: "user1",
      },
    ]);
    expect(adminClientCreations).toBe(0);
  });

  it("ambiguo → grava self_justification trimada e insere project_comments com o contraste e a justificativa", async () => {
    setFieldReview({
      self_verdict: "ambiguo",
      self_justification: "o enunciado não define a unidade",
    });
    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "ambiguo",
      justification: "  o enunciado não define a unidade  ",
    });

    expect(result.success).toBe(true);

    const frUpdate = updateCallsOf("field_reviews")[0];
    expect(frUpdate?.payload).toMatchObject({
      self_verdict: "ambiguo",
      self_justification: "o enunciado não define a unidade",
    });

    const commentInsert = writeCallOf("upsert", "project_comments");
    const rows = commentInsert?.payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: "p1",
      document_id: "doc1",
      field_name: "q1",
      author_id: "user1",
      source_field_review_id: "fr1",
    });
    expect(String(rows[0].body)).toContain("ambíguo");
    expect(String(rows[0].body)).toContain("Adalimumabe");
    expect(String(rows[0].body)).toContain(
      "Justificativa do pesquisador: o enunciado não define a unidade",
    );
    expect(adminClientCreations).toBe(1);
  });

  it("mantém a conta autenticada como autora quando a fila pertence a um membro canônico", async () => {
    auth.getAuthUser.mockResolvedValue({ id: "linked-account" });
    auth.resolveMemberUserId.mockResolvedValue("canonical-member");
    setFieldReview({
      self_verdict: "ambiguo",
      self_justification: "duas leituras possíveis",
    });

    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "ambiguo",
      justification: "duas leituras possíveis",
    });

    expect(result.success).toBe(true);
    const commentInsert = writeCallOf("upsert", "project_comments");
    expect(commentInsert?.payload).toMatchObject([
      { author_id: "linked-account" },
    ]);
    expect(filterCalls).toContainEqual({
      table: "field_reviews",
      method: "eq",
      column: "self_reviewer_id",
      value: "canonical-member",
    });
    expect(adminClientCreations).toBe(1);
  });

  it("retry ambíguo rejeita justificativa diferente da persistida", async () => {
    setFieldReview({
      self_verdict: "ambiguo",
      self_justification: "justificativa original",
    });
    tableData["field_reviews:update"] = [];

    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "ambiguo",
      justification: "texto divergente do retry",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("justificativa enviada difere");
    expect(writeCallOf("upsert", "project_comments")).toBeUndefined();
  });

  it("retry ambíguo idêntico recompõe o comentário ausente", async () => {
    setFieldReview({
      self_verdict: "ambiguo",
      self_justification: "justificativa original",
    });
    tableData["field_reviews:update"] = [];

    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "ambiguo",
      justification: "  justificativa original  ",
    });

    expect(result.success).toBe(true);
    expect(writeCallOf("upsert", "project_comments")).toBeDefined();
  });

  it("expõe falha ao carregar respostas antes do comentário de ambiguidade", async () => {
    setFieldReview({
      self_verdict: "ambiguo",
      self_justification: "duas leituras possíveis",
    });
    tableData["__error:responses:select"] = {
      message: "respostas indisponíveis",
    };

    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "ambiguo",
      justification: "duas leituras possíveis",
    });

    expect(result).toEqual({
      success: false,
      error: "respostas indisponíveis",
    });
    expect(writeCallOf("upsert", "project_comments")).toBeUndefined();
  });

  it("equivalente em retry (UPDATE casa 0 linhas) ainda registra a equivalencia", async () => {
    // Cenario de retry: um call anterior gravou self_verdict='equivalente' mas
    // falhou no upsert de response_equivalences. Agora o UPDATE casa 0 linhas
    // (self_verdict ja nao e NULL), mas o estado real mostra o campo resolvido.
    tableData["field_reviews:update"] = [];
    setFieldReview({ self_verdict: "equivalente" });
    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "equivalente",
    });

    expect(result.success).toBe(true);

    // Apesar do UPDATE nao ter casado, o efeito colateral roda (idempotente).
    const equivalence = writeCallOf("upsert", "response_equivalences");
    expect(equivalence?.payload).toMatchObject([
      { field_name: "q1", response_a_id: "hr1", response_b_id: "lr1" },
    ]);
  });
});

describe("submitAutoReview — envio parcial e conclusão do assignment", () => {
  const assignmentWasCompleted = () =>
    Boolean(
      updateCallsOf("assignments").find(
        (u) => (u.payload as Record<string, unknown>).status === "concluido",
      ),
    );

  it.each([
    {
      label: "ainda há campo pendente",
      pending: [{ id: "fr2" }],
      expectedCompletion: false,
    },
    {
      label: "nenhum campo pendente restante",
      pending: [],
      expectedCompletion: true,
    },
  ])("$label", async ({ pending, expectedCompletion }) => {
    tableData.field_reviews_pending = pending;

    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "admite_erro",
    });

    expect(result.success).toBe(true);
    expect(assignmentWasCompleted()).toBe(expectedCompletion);
  });
});

describe("submitAutoReview — retry e conflito do estado persistido", () => {
  it("retry de contestação sem árbitro repete o sorteio", async () => {
    setFieldReview({
      self_verdict: "contesta_llm",
      self_justification: "resposta correta",
      arbitrator_id: null,
    });
    tableData["field_reviews:update"] = [];
    tableData.project_members = [
      { user_id: "arbitrator1", role: "pesquisador" },
    ];

    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "contesta_llm",
      justification: "resposta correta",
    });

    expect(result).toMatchObject({ success: true, arbitrated: 1 });
    expect(rpcCalls).toContainEqual({
      fn: "assign_arbitration_if_eligible",
      args: {
        p_project_id: "p1",
        p_document_id: "doc1",
        p_user_id: "arbitrator1",
        p_field_names: ["q1"],
      },
    });
  });

  it("rejeita retry com veredito diferente do persistido", async () => {
    setFieldReview({ self_verdict: "admite_erro" });
    tableData["field_reviews:update"] = [];

    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "contesta_llm",
      justification: "resposta correta",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("já registrada com valor diferente");
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejeita campo inexistente em vez de concluir silenciosamente", async () => {
    tableData["field_reviews:update"] = [];
    tableData.field_reviews = [];

    const result = await submitAutoReview({
      fieldName: "inexistente",
      verdict: "admite_erro",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("não encontrada ou sem permissão");
    expect(updateCallsOf("assignments")).toHaveLength(0);
  });

  it("não conclui o assignment quando o comentário automático falha", async () => {
    setFieldReview({
      self_verdict: "ambiguo",
      self_justification: "duas leituras",
    });
    tableData["__error:project_comments:upsert"] = {
      message: "comentários indisponíveis",
    };

    const result = await submitAutoReview({
      fieldName: "q1",
      verdict: "ambiguo",
      justification: "duas leituras",
    });

    expect(result).toEqual({
      success: false,
      error: "comentários indisponíveis",
    });
    expect(updateCallsOf("assignments")).toHaveLength(0);
  });
});

describe("submitBlindVerdicts — validação de entrada", () => {
  it.each([
    {
      label: "ID vazio",
      choice: { fieldReviewId: "   ", choice: "a" as const },
      error: "ID da revisão cega é obrigatório.",
    },
    {
      label: "escolha fora do contrato runtime",
      choice: { fieldReviewId: "fr1", choice: "x" as never },
      error: 'Escolha inválida para a revisão "fr1".',
    },
  ])("rejeita $label antes de qualquer escrita", async ({ choice, error }) => {
    const action = (await import("@/actions/field-reviews"))
      .submitBlindVerdicts;

    const result = await action("p1", "doc1", [choice]);

    expect(result).toEqual({ success: false, error });
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("rejeita a mesma revisão duas vezes antes de qualquer escrita", async () => {
    const action = (await import("@/actions/field-reviews"))
      .submitBlindVerdicts;

    const result = await action("p1", "doc1", [
      { fieldReviewId: "fr1", choice: "a" },
      { fieldReviewId: "fr1", choice: "b" },
    ]);

    expect(result).toEqual({
      success: false,
      error: 'Revisão "fr1" enviada mais de uma vez.',
    });
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("expõe erro da releitura usada para validar retry", async () => {
    tableData["field_reviews:update"] = [];
    tableData["__error:field_reviews:select"] = {
      message: "releitura indisponível",
    };
    const action = (await import("@/actions/field-reviews"))
      .submitBlindVerdicts;

    const result = await action("p1", "doc1", [
      { fieldReviewId: "fr1", choice: "a" },
    ]);

    expect(result).toEqual({
      success: false,
      error: "releitura indisponível",
    });
  });
});

describe("submitFinalVerdicts — validação de entrada", () => {
  it.each([undefined, "   \n\t"])(
    "exige sugestão quando o árbitro decide pelo LLM (%j)",
    async (questionImprovementSuggestion) => {
      const result = await submitFinalVerdict({
        fieldName: "q1",
        verdict: "llm",
        questionImprovementSuggestion,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("sugestão de melhoria obrigatória");
      expect(updateCallsOf()).toHaveLength(0);
    },
  );

  it("rejeita o mesmo campo duas vezes antes de qualquer escrita", async () => {
    const action = (await import("@/actions/field-reviews"))
      .submitFinalVerdicts;
    const result = await action("p1", "doc1", [
      { fieldName: "q1", verdict: "humano" },
      { fieldName: "q1", verdict: "humano" },
    ]);

    expect(result).toEqual({
      success: false,
      error: 'Campo "q1" enviado mais de uma vez.',
    });
    expect(updateCallsOf()).toHaveLength(0);
  });
});

describe("submitFinalVerdicts — persistência e identidade", () => {
  it("grava na fila canônica e atribui o comentário à conta autenticada", async () => {
    auth.getAuthUser.mockResolvedValue({ id: "linked-account" });
    auth.resolveMemberUserId.mockResolvedValue("canonical-member");

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "llm",
      questionImprovementSuggestion: "Definir a unidade esperada",
      arbitratorComment: "A resposta humana usou outra escala",
    });

    expect(result.success).toBe(true);
    expect(updateCallsOf("field_reviews")[0]?.payload).toMatchObject({
      final_verdict: "llm",
      question_improvement_suggestion: "Definir a unidade esperada",
      arbitrator_comment: "A resposta humana usou outra escala",
    });
    expect(filterCalls).toContainEqual({
      table: "field_reviews",
      method: "eq",
      column: "arbitrator_id",
      value: "canonical-member",
    });

    const comment = writeCallOf("upsert", "project_comments");
    expect(comment?.payload).toMatchObject([
      {
        author_id: "linked-account",
        field_name: "q1",
        source_field_review_id: "fr1",
      },
    ]);
    const commentBody = String(
      (comment?.payload as Array<Record<string, unknown>>)[0].body,
    );
    expect(commentBody).toContain("Adalimumabe");
    expect(commentBody).toContain("Definir a unidade esperada");
    expect(commentBody).toContain("A resposta humana usou outra escala");
    expect(rpcCalls).toContainEqual({
      fn: "sync_arbitration_assignment_status",
      args: {
        p_project_id: "p1",
        p_document_id: "doc1",
        p_user_id: "canonical-member",
      },
    });
    expect(adminClientCreations).toBe(1);
  });

  it("retry com o mesmo veredito pula o UPDATE e recompõe o comentário", async () => {
    setFieldReview({
      final_verdict: "llm",
      question_improvement_suggestion: "Definir a unidade esperada",
    });

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "llm",
      questionImprovementSuggestion: "Definir a unidade esperada",
    });

    expect(result.success).toBe(true);
    expect(updateCallsOf("field_reviews")).toHaveLength(0);
    expect(writeCallOf("upsert", "project_comments")).toBeDefined();
  });

  it("nota manual no campo não suprime o comentário automático", async () => {
    tableData.project_comments = [
      { field_name: "q1", body: "Nota manual anterior" },
    ];

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "llm",
      questionImprovementSuggestion: "Definir a unidade esperada",
    });

    expect(result.success).toBe(true);
    expect(writeCallOf("upsert", "project_comments")).toBeDefined();
  });

  it("retry usa a mesma revisão de origem idempotente do comentário", async () => {
    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "llm",
      questionImprovementSuggestion: "Definir a unidade esperada",
    });

    expect(result.success).toBe(true);
    expect(writeCallOf("upsert", "project_comments")?.payload).toMatchObject([
      { source_field_review_id: "fr1" },
    ]);
  });
});

describe("submitFinalVerdicts — estado anterior", () => {
  it("rejeita retry com veredito final diferente", async () => {
    setFieldReview({ final_verdict: "humano" });

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "llm",
      questionImprovementSuggestion: "Definir a unidade esperada",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('já registrado como "humano"');
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("rejeita retry com detalhes diferentes do veredito persistido", async () => {
    setFieldReview({
      final_verdict: "llm",
      question_improvement_suggestion: "Definir a unidade esperada",
    });

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "llm",
      questionImprovementSuggestion: "Trocar a escala da pergunta",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("detalhes enviados diferem");
    expect(updateCallsOf()).toHaveLength(0);
    expect(writeCallOf("upsert", "project_comments")).toBeUndefined();
  });

  it("impede veredito final antes da fase cega", async () => {
    setFieldReview({ blind_verdict: null });

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "humano",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("fase cega ainda não decidida");
    expect(updateCallsOf()).toHaveLength(0);
  });
});

describe("submitFinalVerdicts — falhas de persistência", () => {
  it("aceita vencedor concorrente com o mesmo payload completo", async () => {
    tableData["field_reviews:update"] = [];
    tableData["field_reviews:after-empty-update"] = [
      fieldReview({
        final_verdict: "llm",
        question_improvement_suggestion: "Definir a unidade esperada",
        arbitrator_comment: "Comparação confirmada",
      }),
    ];

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "llm",
      questionImprovementSuggestion: " Definir a unidade esperada ",
      arbitratorComment: "Comparação confirmada",
    });

    expect(result.success).toBe(true);
    expect(writeCallOf("upsert", "project_comments")?.payload).toMatchObject([
      { source_field_review_id: "fr1" },
    ]);
  });

  it("rejeita vencedor concorrente com payload divergente", async () => {
    tableData["field_reviews:update"] = [];
    tableData["field_reviews:after-empty-update"] = [
      fieldReview({ final_verdict: "llm" }),
    ];

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "humano",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('já registrado como "llm"');
  });

  it("expõe rejeição concorrente do UPDATE", async () => {
    tableData["field_reviews:update"] = [];

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "humano",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("UPDATE rejeitado (concorrência ou RLS)");
  });

  it("expõe falha do comentário depois de salvar o veredito", async () => {
    tableData["__error:project_comments:upsert"] = {
      message: "insert indisponível",
    };

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "llm",
      questionImprovementSuggestion: "Definir a unidade esperada",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Veredicto salvo mas comentário de divergência falhou: insert indisponível",
    );
    expect(updateCallsOf("field_reviews")).toHaveLength(1);
    expect(updateCallsOf("assignments")).toHaveLength(0);
  });

  it("expõe falha ao carregar as revisões", async () => {
    tableData["__error:field_reviews:select"] = {
      message: "leitura indisponível",
    };

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "humano",
    });

    expect(result).toEqual({ success: false, error: "leitura indisponível" });
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("expõe falha ao carregar as respostas do comentário", async () => {
    tableData["__error:responses:select"] = {
      message: "respostas indisponíveis",
    };

    const result = await submitFinalVerdict({
      fieldName: "q1",
      verdict: "llm",
      questionImprovementSuggestion: "Definir a unidade esperada",
    });

    expect(result).toEqual({
      success: false,
      error: "respostas indisponíveis",
    });
    expect(updateCallsOf()).toHaveLength(0);
  });
});
