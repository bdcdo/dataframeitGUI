import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock minimo do supabase: captura os payloads de .update()/.upsert()/.insert()
// para validar o que submitAutoReview enviaria ao DB sem subir Postgres.
// Builder chainable e thenable — `await builder` (ou apos .select()) resolve
// { data, error }.
type WriteCall = { table: string; op: string; payload: unknown };
let writeCalls: WriteCall[];
let tableData: Record<string, unknown>;

const updateCallsOf = (table?: string) =>
  writeCalls.filter((c) => c.op === "update" && (!table || c.table === table));

function makeClient() {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      let op = "select";
      for (const m of ["select", "eq", "is", "in", "neq"]) {
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
      // Resolve por operacao quando ha override `${table}:${op}` — permite um
      // teste fazer o UPDATE casar 0 linhas mas o SELECT de estado ver a linha
      // (cenario de retry apos falha parcial). Senao cai no dado generico.
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data: tableData[`${table}:${op}`] ?? tableData[table] ?? null,
          error: null,
        });
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
  writeCalls = [];
  tableData = {
    // UPDATE de field_reviews retorna a linha tocada (via .select). O SELECT de
    // estado real (efeitos de equivalente/ambiguo) le esta mesma linha — testes
    // desses vereditos sobrescrevem `self_verdict` conforme o caso.
    field_reviews: [
      {
        field_name: "q1",
        human_response_id: "hr1",
        llm_response_id: "lr1",
      },
    ],
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
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("contesta_llm com justificativa só de espaços → erro e nenhum UPDATE", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldName: "q1", verdict: "contesta_llm", justification: "   \n\t" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("justificativa obrigatória");
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("admite_erro → passa na validacao e grava self_justification: null", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldName: "q1", verdict: "admite_erro" },
    ]);
    expect(r.success).toBe(true);
    const frUpdate = updateCallsOf("field_reviews")[0];
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
    const frUpdate = updateCallsOf("field_reviews")[0];
    expect(frUpdate?.payload).toMatchObject({
      self_verdict: "contesta_llm",
      self_justification: "confere",
    });
  });
});

describe("submitAutoReview — vereditos equivalente e ambiguo", () => {
  it("equivalente → faz upsert do par canonico em response_equivalences", async () => {
    const submitAutoReview = await loadSubmit();
    tableData.field_reviews = [
      {
        field_name: "q1",
        human_response_id: "hr1",
        llm_response_id: "lr1",
        self_verdict: "equivalente",
      },
    ];
    const r = await submitAutoReview("p1", "doc1", [
      { fieldName: "q1", verdict: "equivalente" },
    ]);
    expect(r.success).toBe(true);

    const frUpdate = updateCallsOf("field_reviews")[0];
    expect(frUpdate?.payload).toMatchObject({
      self_verdict: "equivalente",
      self_justification: null,
    });

    const equivUpsert = writeCalls.find(
      (c) => c.op === "upsert" && c.table === "response_equivalences",
    );
    expect(equivUpsert).toBeDefined();
    // canonicalPair("hr1", "lr1") → ["hr1", "lr1"] (hr1 < lr1)
    expect(equivUpsert?.payload).toMatchObject([
      {
        project_id: "p1",
        document_id: "doc1",
        field_name: "q1",
        response_a_id: "hr1",
        response_b_id: "lr1",
        reviewer_id: "user1",
      },
    ]);
  });

  it("ambiguo sem justificativa → erro e nenhum UPDATE", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldName: "q1", verdict: "ambiguo" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("justificativa obrigatória");
    expect(r.error).toContain("ambíguo");
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("ambiguo com justificativa só de espaços → erro e nenhum UPDATE", async () => {
    const submitAutoReview = await loadSubmit();
    const r = await submitAutoReview("p1", "doc1", [
      { fieldName: "q1", verdict: "ambiguo", justification: "   \n\t" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("justificativa obrigatória");
    expect(updateCallsOf()).toHaveLength(0);
  });

  it("ambiguo → grava self_justification trimada e insere project_comments com o contraste e a justificativa", async () => {
    const submitAutoReview = await loadSubmit();
    tableData.field_reviews = [
      {
        field_name: "q1",
        human_response_id: "hr1",
        llm_response_id: "lr1",
        self_verdict: "ambiguo",
      },
    ];
    const r = await submitAutoReview("p1", "doc1", [
      {
        fieldName: "q1",
        verdict: "ambiguo",
        justification: "  o enunciado não define a unidade  ",
      },
    ]);
    expect(r.success).toBe(true);

    const frUpdate = updateCallsOf("field_reviews")[0];
    expect(frUpdate?.payload).toMatchObject({
      self_verdict: "ambiguo",
      self_justification: "o enunciado não define a unidade",
    });

    const commentInsert = writeCalls.find(
      (c) => c.op === "insert" && c.table === "project_comments",
    );
    expect(commentInsert).toBeDefined();
    const rows = commentInsert?.payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: "p1",
      document_id: "doc1",
      field_name: "q1",
      author_id: "user1",
    });
    expect(String(rows[0].body)).toContain("ambíguo");
    expect(String(rows[0].body)).toContain("Adalimumabe");
    expect(String(rows[0].body)).toContain(
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
        field_name: "q1",
        human_response_id: "hr1",
        llm_response_id: "lr1",
        self_verdict: "equivalente",
      },
    ];
    const r = await submitAutoReview("p1", "doc1", [
      { fieldName: "q1", verdict: "equivalente" },
    ]);
    expect(r.success).toBe(true);

    // Apesar do UPDATE nao ter casado, o efeito colateral roda (idempotente).
    const equivUpsert = writeCalls.find(
      (c) => c.op === "upsert" && c.table === "response_equivalences",
    );
    expect(equivUpsert).toBeDefined();
    expect(equivUpsert?.payload).toMatchObject([
      { field_name: "q1", response_a_id: "hr1", response_b_id: "lr1" },
    ]);
  });
});
