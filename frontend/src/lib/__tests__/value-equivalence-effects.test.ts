import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFilterAwareSupabaseMock, type RpcCall, type RpcResult, type WriteCall } from "@/test-utils/supabase-mock";

let tableData: Record<string, unknown[]>;
let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let rpcResults: Record<string, RpcResult>;

const { mockDrain, mockResync } = vi.hoisted(() => ({
  mockDrain: vi.fn(async () => ({ processed: 0, stale: 0, failed: 0, remaining: 0 })),
  mockResync: vi.fn(async () => ({ checked: 0, changes: [] })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeFilterAwareSupabaseMock({ tableData, writeCalls, rpcCalls, rpcResults }),
}));
vi.mock("@/lib/auto-review-reconciler", () => ({
  drainAutoReviewReconciliationRequests: mockDrain,
}));
vi.mock("@/lib/compare-assignment-sync", () => ({
  resyncProjectCompareAssignments: mockResync,
}));

beforeAll(async () => {
  await import("@/lib/value-equivalence-effects");
  await import("@/lib/supabase/admin");
}, 30_000);

beforeEach(() => {
  tableData = {};
  writeCalls = [];
  rpcCalls = [];
  rpcResults = {};
  mockDrain.mockClear();
  mockResync.mockClear();
});

const key = (value: unknown) => JSON.stringify(value);

// Resposta com as colunas que `fetchFieldAnswers` filtra. O caminho JSON
// `answers->campo` e a coluna do embed são chaves literais da linha, e o mock
// copia o caminho para o alias `value` do select. `value: null` aqui é o
// caminho SQL NULL (a resposta sem a chave), e não o JSON null; o campo que a
// resposta não tem fica sem a chave, e as duas formas não passam no
// `.not(answers->campo, is, null)`.
const answer = (id: string, document_id: string, field: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  id, document_id, project_id: "p1", is_latest: true, "documents.excluded_at": null,
  [`answers->${field}`]: value, ...extra,
});
// Linhas que os filtros precisam descartar, com um valor que todo teste
// procura: versão antiga, outro projeto e documento arquivado.
const filteredOut = (field: string, value: unknown) => [
  answer("x1", "d-antiga", field, value, { is_latest: false }),
  answer("x2", "d-alheio", field, value, { project_id: "p2" }),
  answer("x3", "d-arquivado", field, value, { "documents.excluded_at": "2026-01-01" }),
];

describe("documentsWithValues", () => {
  it("documentos com resposta vigente num dos valores, pela chave normalizada", async () => {
    const { documentsWithValues } = await import("@/lib/value-equivalence-effects");
    tableData.responses = [
      answer("r1", "d1", "q1", "Não Informado "),
      answer("r2", "d2", "q1", "outra"),
      answer("r3", "d3", "q1", "N/A"),
      answer("r4", "d1", "q1", "N/A"),
      ...filteredOut("q1", "N/A"),
    ];
    const { createSupabaseAdmin } = await import("@/lib/supabase/admin");
    const docs = await documentsWithValues(
      createSupabaseAdmin(),
      "p1",
      "q1",
      new Set([key("nao informado"), key("n/a")]),
    );
    expect(docs.sort()).toEqual(["d1", "d3"]);
  });

  // O nome entra no select como caminho JSON do PostgREST.
  it("recusa nome de campo que não é identificador", async () => {
    const { documentsWithValues } = await import("@/lib/value-equivalence-effects");
    const { createSupabaseAdmin } = await import("@/lib/supabase/admin");
    await expect(
      documentsWithValues(createSupabaseAdmin(), "p1", "q1,answers", new Set([key("x")])),
    ).rejects.toThrow(/nome de campo inválido/);
  });
});

describe("propagateValueEquivalenceChange", () => {
  const projects = [
    { id: "p1", pydantic_fields: [{ name: "q1", type: "text", hash: "h1" }] },
    { id: "p2", pydantic_fields: [] },
  ];
  const equivalence = (id: string, value_a: string, value_b: string, project_id = "p1") => ({
    id, project_id, field_name: "q1", field_hash: "h1", value_a, value_b, reviewer_id: null,
  });

  it("enfileira só os documentos afetados, drena e ressincroniza só eles", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    tableData = {
      projects,
      value_equivalences: [],
      responses: [answer("r1", "d1", "q1", "NI"), answer("r2", "d2", "q1", "outra"), ...filteredOut("q1", "NI")],
    };
    await propagateValueEquivalenceChange({ projectId: "p1", changes: [{ fieldName: "q1", values: ["ni"] }] });
    expect(rpcCalls).toEqual([{
      fn: "enqueue_auto_review_reconciliation_for_documents",
      args: { p_project_id: "p1", p_document_ids: ["d1"] },
    }]);
    expect(mockDrain).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" });
    // A fila é a RPC: nenhuma escrita direta em tabela.
    expect(writeCalls).toEqual([]);
    // Só os documentos afetados, e não o projeto inteiro.
    expect(mockResync).toHaveBeenCalledExactlyOnceWith(expect.anything(), "p1", { documentIds: ["d1"] });
  });

  it("expande a classe pelas equivalências do campo, já com a nova", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    tableData = {
      projects,
      // A equivalência de outro projeto não entra na classe.
      value_equivalences: [equivalence("e1", "N/A", "não se aplica"), equivalence("e9", "N/A", "nada", "p2")],
      responses: [answer("r9", "d9", "q1", "não se aplica"), answer("r8", "d8", "q1", "nada")],
    };
    await propagateValueEquivalenceChange({ projectId: "p1", changes: [{ fieldName: "q1", values: ["NI", "N/A"] }] });
    expect(rpcCalls[0]?.args).toEqual({ p_project_id: "p1", p_document_ids: ["d9"] });
  });

  // Desfazer: a equivalência já saiu da tabela, mas a classe ANTIGA (com ela)
  // é onde a divergência pode reaparecer.
  it("equivalência desfeita entra no cálculo da classe antiga", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    tableData = {
      projects,
      value_equivalences: [equivalence("e2", "N/A", "não se aplica")],
      responses: [answer("r9", "d9", "q1", "não se aplica")],
    };
    await propagateValueEquivalenceChange({
      projectId: "p1",
      changes: [{
        fieldName: "q1",
        values: ["NI", "N/A"],
        removed: { id: "e1", field_name: "q1", field_hash: "h1", value_a: "NI", value_b: "N/A", reviewer_id: null },
      }],
    });
    expect(rpcCalls[0]?.args).toEqual({ p_project_id: "p1", p_document_ids: ["d9"] });
  });

  it("sem documento afetado não enfileira, não drena e não ressincroniza", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    tableData = { projects, value_equivalences: [], responses: filteredOut("q1", "x") };
    await propagateValueEquivalenceChange({ projectId: "p1", changes: [{ fieldName: "q1", values: ["x"] }] });
    expect(rpcCalls).toEqual([]);
    expect(mockDrain).not.toHaveBeenCalled();
    expect(mockResync).not.toHaveBeenCalled();
  });

  // Um envio de auto-revisão com vários "equivalente" vira UMA propagação:
  // documentos unidos, uma drenagem e uma ressincronização, e uma leitura das
  // equivalências para todos os campos.
  it("várias mudanças: uma leitura, uma fila, uma drenagem, uma ressincronização", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    tableData = {
      value_equivalences: [],
      projects: [{ id: "p1", pydantic_fields: [] }],
      // r1 não respondeu q2 nem r2 e r3 responderam q1: cada leitura por campo
      // só vê quem tem a chave.
      responses: [
        answer("r1", "d1", "q1", "NI"),
        answer("r2", "d2", "q2", "sim"),
        answer("r3", "d1", "q2", "sim"),
        answer("r4", "d4", "q2", "ni"),
      ],
    };
    await propagateValueEquivalenceChange({
      projectId: "p1",
      changes: [{ fieldName: "q1", values: ["ni"] }, { fieldName: "q2", values: ["sim"] }],
    });
    expect(rpcCalls).toHaveLength(1);
    expect((rpcCalls[0].args as { p_document_ids: string[] }).p_document_ids.sort()).toEqual(["d1", "d2"]);
    expect(mockDrain).toHaveBeenCalledOnce();
    expect(mockResync).toHaveBeenCalledOnce();
  });

  it("lê só as respostas que têm a chave do campo", async () => {
    const { documentsWithValues } = await import("@/lib/value-equivalence-effects");
    const { createSupabaseAdmin } = await import("@/lib/supabase/admin");
    // Sem a chave, `answers->q1` é SQL NULL e o alias `value` viria null: o
    // filtro é o que impede a resposta de casar com o valor null.
    tableData.responses = [answer("r1", "d1", "q1", null)];
    expect(await documentsWithValues(createSupabaseAdmin(), "p1", "q1", new Set([key(null)]))).toEqual([]);
  });

  // Pós-commit: a equivalência já está gravada; falhar aqui só registra.
  it("falha não lança, só registra", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tableData = { projects, value_equivalences: [], responses: [answer("r1", "d1", "q1", "NI")] };
    rpcResults.enqueue_auto_review_reconciliation_for_documents = { error: { message: "enqueue boom" } };
    await expect(
      propagateValueEquivalenceChange({ projectId: "p1", changes: [{ fieldName: "q1", values: ["ni"] }] }),
    ).resolves.toBeUndefined();
    expect(errorSpy.mock.calls[0]?.[0]).toContain("enqueue boom");
    expect(mockResync).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // A drenagem e a ressincronização correm juntas: a falha de uma não impede
  // a outra.
  it("falha da drenagem não impede a ressincronização", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockDrain.mockRejectedValueOnce(new Error("drain boom"));
    tableData = { projects, value_equivalences: [], responses: [answer("r1", "d1", "q1", "NI")] };
    await propagateValueEquivalenceChange({ projectId: "p1", changes: [{ fieldName: "q1", values: ["ni"] }] });
    expect(mockResync).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]?.[0]).toContain("drain boom");
    errorSpy.mockRestore();
  });
});
