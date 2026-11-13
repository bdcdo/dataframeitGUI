import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseMock, type RpcCall, type TableResults, type FilterCall } from "@/actions/__tests__/supabase-mock";

let tableResults: TableResults;
let rpcCalls: RpcCall[];
let rpcResults: Record<string, { data?: unknown; error?: { message: string } | null }>;
let filterCalls: FilterCall[];

const { mockDrain, mockResync } = vi.hoisted(() => ({
  mockDrain: vi.fn(async () => ({ processed: 0, stale: 0, failed: 0, remaining: 0 })),
  mockResync: vi.fn(async () => ({ checked: 0, changes: [] })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeSupabaseMock({ tableResults, rpcCalls, rpcResults, filterCalls }),
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
  tableResults = {};
  rpcCalls = [];
  rpcResults = {};
  filterCalls = [];
  mockDrain.mockClear();
  mockResync.mockClear();
});

const key = (value: unknown) => JSON.stringify(value);

describe("documentsWithValues", () => {
  it("documentos com resposta vigente num dos valores, pela chave normalizada", async () => {
    const { documentsWithValues } = await import("@/lib/value-equivalence-effects");
    tableResults.responses = {
      data: [
        { id: "r1", document_id: "d1", value: "Não Informado " },
        { id: "r2", document_id: "d2", value: "outra" },
        { id: "r3", document_id: "d3", value: "N/A" },
        { id: "r4", document_id: "d1", value: "N/A" },
      ],
    };
    const { createSupabaseAdmin } = await import("@/lib/supabase/admin");
    const docs = await documentsWithValues(
      createSupabaseAdmin(),
      "p1",
      "q1",
      new Set([key("nao informado"), key("n/a")]),
    );
    expect(docs.sort()).toEqual(["d1", "d3"]);
    expect(filterCalls).toContainEqual({ table: "responses", method: "eq", column: "is_latest", value: true });
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
  const Q1 = { projects: { data: { pydantic_fields: [{ name: "q1", type: "text", hash: "h1" }] } } };

  it("enfileira só os documentos afetados, drena e ressincroniza só eles", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    tableResults = {
      ...Q1,
      value_equivalences: { data: [] },
      responses: { data: [
        { id: "r1", document_id: "d1", value: "NI" },
        { id: "r2", document_id: "d2", value: "outra" },
      ] },
    };
    await propagateValueEquivalenceChange({ projectId: "p1", changes: [{ fieldName: "q1", values: ["ni"] }] });
    expect(rpcCalls).toEqual([{
      fn: "enqueue_auto_review_reconciliation_for_documents",
      args: { p_project_id: "p1", p_document_ids: ["d1"] },
    }]);
    expect(mockDrain).toHaveBeenCalledExactlyOnceWith({ projectId: "p1" });
    // Só os documentos afetados, e não o projeto inteiro.
    expect(mockResync).toHaveBeenCalledExactlyOnceWith(expect.anything(), "p1", { documentIds: ["d1"] });
  });

  it("expande a classe pelas equivalências do campo, já com a nova", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    tableResults = {
      ...Q1,
      value_equivalences: {
        data: [{ id: "e1", field_name: "q1", field_hash: "h1", value_a: "N/A", value_b: "não se aplica", reviewer_id: null }],
      },
      responses: { data: [{ id: "r9", document_id: "d9", value: "não se aplica" }] },
    };
    await propagateValueEquivalenceChange({ projectId: "p1", changes: [{ fieldName: "q1", values: ["NI", "N/A"] }] });
    expect(rpcCalls[0]?.args).toEqual({ p_project_id: "p1", p_document_ids: ["d9"] });
  });

  // Desfazer: a equivalência já saiu da tabela, mas a classe ANTIGA (com ela)
  // é onde a divergência pode reaparecer.
  it("equivalência desfeita entra no cálculo da classe antiga", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    tableResults = {
      ...Q1,
      value_equivalences: {
        data: [{ id: "e2", field_name: "q1", field_hash: "h1", value_a: "N/A", value_b: "não se aplica", reviewer_id: null }],
      },
      responses: { data: [{ id: "r9", document_id: "d9", value: "não se aplica" }] },
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
    tableResults = { ...Q1, value_equivalences: { data: [] }, responses: { data: [] } };
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
    tableResults = {
      value_equivalences: { data: [] },
      projects: [{ data: null }, { data: null }],
      responses: [
        { data: [{ id: "r1", document_id: "d1", value: "NI" }] },
        { data: [{ id: "r2", document_id: "d2", value: "sim" }, { id: "r3", document_id: "d1", value: "sim" }] },
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
    tableResults.responses = { data: [] };
    await documentsWithValues(createSupabaseAdmin(), "p1", "q1", new Set([key("null")]));
    expect(filterCalls).toContainEqual({ table: "responses", method: "not", column: "answers->q1", value: null });
  });

  // Pós-commit: a equivalência já está gravada; falhar aqui só registra.
  it("falha não lança, só registra", async () => {
    const { propagateValueEquivalenceChange } = await import("@/lib/value-equivalence-effects");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tableResults = { ...Q1, value_equivalences: { data: [] }, responses: { data: [{ id: "r1", document_id: "d1", value: "NI" }] } };
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
    tableResults = { ...Q1, value_equivalences: { data: [] }, responses: { data: [{ id: "r1", document_id: "d1", value: "NI" }] } };
    await propagateValueEquivalenceChange({ projectId: "p1", changes: [{ fieldName: "q1", values: ["ni"] }] });
    expect(mockResync).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]?.[0]).toContain("drain boom");
    errorSpy.mockRestore();
  });
});
