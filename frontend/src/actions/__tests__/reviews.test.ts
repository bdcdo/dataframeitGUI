import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock minimo do supabase: captura insert/delete em project_comments para
// validar o comportamento do submitVerdict com veredito "ambiguo" sem subir
// Postgres. Builder chainable e thenable. Os dados retornados por tabela sao
// controlados por `tableData` (setado por teste).
type OpCall = { op: string; table: string; payload?: Record<string, unknown> };
let opCalls: OpCall[];
let tableData: Record<string, unknown>;

const { mockGetEffectiveMemberId, mockCreateSupabaseServer } = vi.hoisted(
  () => ({
    mockGetEffectiveMemberId: vi.fn<() => Promise<string>>(),
    mockCreateSupabaseServer: vi.fn(),
  }),
);

function makeClient() {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of [
        "select",
        "eq",
        "is",
        "in",
        "neq",
        "not",
        "order",
        "limit",
      ]) {
        builder[m] = () => builder;
      }
      builder.upsert = (payload: Record<string, unknown>) => {
        opCalls.push({ op: "upsert", table, payload });
        return builder;
      };
      builder.insert = (payload: Record<string, unknown>) => {
        opCalls.push({ op: "insert", table, payload });
        return builder;
      };
      builder.delete = () => {
        opCalls.push({ op: "delete", table });
        return builder;
      };
      builder.update = (payload: Record<string, unknown>) => {
        opCalls.push({ op: "update", table, payload });
        return builder;
      };
      builder.maybeSingle = async () => ({
        data: tableData[table] ?? null,
        error: null,
      });
      builder.single = async () => ({
        data: tableData[table] ?? null,
        error: null,
      });
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: tableData[table] ?? null, error: null });
      return builder;
    },
  };
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "user1" }),
  // Sem alias nos cenários destes testes: identidade efetiva = a própria conta.
  getEffectiveMemberId: mockGetEffectiveMemberId,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: mockCreateSupabaseServer,
}));
// syncCompareAssignment curto-circuita: assignment ausente => retorno imediato.
vi.mock("@/lib/compare-sync", () => ({
  syncCompareAssignment: async () => {},
}));

beforeEach(() => {
  opCalls = [];
  tableData = {};
  mockGetEffectiveMemberId.mockReset().mockResolvedValue("user1");
  mockCreateSupabaseServer
    .mockReset()
    .mockImplementation(async () => makeClient());
});

async function loadActions() {
  return await import("@/actions/reviews");
}

async function loadSubmit() {
  return (await loadActions()).submitVerdict;
}

describe.each([
  {
    failure: "lookup de identidade",
    arrange: () =>
      mockGetEffectiveMemberId.mockRejectedValueOnce(
        new Error("identity lookup boom"),
      ),
    expectedError: "identity lookup boom",
  },
  {
    failure: "criação do client",
    arrange: () =>
      mockCreateSupabaseServer.mockRejectedValueOnce(
        new Error("server client boom"),
      ),
    expectedError: "server client boom",
  },
])("actions de review — falha na $failure", ({ arrange, expectedError }) => {
  it.each([
    {
      action: "submitVerdict",
      call: async () => {
        const { submitVerdict } = await loadActions();
        return submitVerdict("p1", "doc1", "q1", "concordo");
      },
    },
    {
      action: "markCompareDocReviewed",
      call: async () => {
        const { markCompareDocReviewed } = await loadActions();
        return markCompareDocReviewed("p1", "doc1");
      },
    },
  ])("$action retorna { error } sem iniciar escrita", async ({ call }) => {
    arrange();

    await expect(call()).resolves.toEqual({ error: expectedError });
    expect(opCalls).toEqual([]);
  });
});

describe("submitVerdict — veredito ambiguo vira comentario automatico", () => {
  it("ambiguo sem comentario existente → insere project_comments kind='ambiguity'", async () => {
    tableData = { project_comments: null };
    const submitVerdict = await loadSubmit();
    await submitVerdict("p1", "doc1", "q1", "ambiguo");

    const insert = opCalls.find(
      (c) => c.op === "insert" && c.table === "project_comments",
    );
    expect(insert?.payload).toMatchObject({
      project_id: "p1",
      document_id: "doc1",
      field_name: "q1",
      kind: "ambiguity",
      body: "Campo marcado como ambíguo na revisão (aba Comparar).",
    });
  });

  it("ambiguo com comentario do revisor → preserva o texto trimado no corpo", async () => {
    tableData = { project_comments: null };
    const submitVerdict = await loadSubmit();
    await submitVerdict(
      "p1",
      "doc1",
      "q1",
      "ambiguo",
      undefined,
      "  depende do contexto  ",
    );

    const insert = opCalls.find(
      (c) => c.op === "insert" && c.table === "project_comments",
    );
    expect(insert?.payload?.body).toBe(
      "Campo marcado como ambíguo na revisão (aba Comparar): depende do contexto",
    );
  });

  it("ambiguo com comentario ja existente → nao insere de novo (idempotente)", async () => {
    tableData = { project_comments: { id: "pc1" } };
    const submitVerdict = await loadSubmit();
    await submitVerdict("p1", "doc1", "q1", "ambiguo");

    expect(opCalls.some((c) => c.op === "insert")).toBe(false);
  });

  it("verdict nao-ambiguo e nenhum outro revisor ambiguo → deleta o comentario orfao", async () => {
    // reviews query (stillAmbiguous) retorna vazio
    tableData = { reviews: [] };
    const submitVerdict = await loadSubmit();
    await submitVerdict("p1", "doc1", "q1", "concordo");

    expect(
      opCalls.some((c) => c.op === "delete" && c.table === "project_comments"),
    ).toBe(true);
  });

  it("verdict nao-ambiguo mas outro revisor ainda marca ambiguo → nao deleta", async () => {
    tableData = { reviews: [{ id: "r2" }] };
    const submitVerdict = await loadSubmit();
    await submitVerdict("p1", "doc1", "q1", "concordo");

    expect(opCalls.some((c) => c.op === "delete")).toBe(false);
  });
});
