import { describe, it, expect, beforeEach, vi } from "vitest";

// Cobertura de regressão para o bug relatado na issue #366 ("não tá indo a
// resposta da equivalencia"): antes da PR #362, estas actions lançavam Error
// (mascarado pelo Next 16 em produção) e o client fazia escrita otimista antes
// de aguardar o resultado. Hoje retornam `{ error? }`; estes testes travam
// esse contrato — nenhuma das três pode voltar a lançar em vez de retornar.
import {
  makeSupabaseMock,
  type RpcCall,
  type TableResult,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let rpcResults: Record<string, TableResult>;
let serverTableResults: TableResults | undefined;

const { mockGetEffectiveMemberId, mockSyncCompareAssignment } = vi.hoisted(
  () => ({
    mockGetEffectiveMemberId: vi.fn(async () => "canonical-reviewer"),
    mockSyncCompareAssignment: vi.fn(async () => {}),
  }),
);

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getEffectiveMemberId: mockGetEffectiveMemberId,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({
      tableResults: serverTableResults,
      writeCalls,
      rpcCalls,
      rpcResults,
    }),
}));
// syncCompareAssignment é best-effort e teria seu próprio teste dedicado
// (compare-sync.ts); aqui só interessa não deixá-lo derrubar a action.
vi.mock("@/lib/compare-sync", () => ({
  syncCompareAssignment: mockSyncCompareAssignment,
}));

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  rpcResults = {};
  serverTableResults = undefined;
  mockGetEffectiveMemberId.mockClear();
  mockSyncCompareAssignment.mockClear();
});

async function loadActions() {
  return await import("@/actions/equivalences");
}

function upsertsOn(table: string) {
  return writeCalls.filter((c) => c.op === "upsert" && c.table === table);
}

function expectCanonicalIdentityLookup() {
  expect(mockGetEffectiveMemberId).toHaveBeenCalledOnce();
  expect(mockGetEffectiveMemberId).toHaveBeenCalledWith("p1");
}

function expectCanonicalAssignmentSync() {
  expect(mockSyncCompareAssignment).toHaveBeenCalledWith(
    expect.anything(),
    "p1",
    "doc1",
    "canonical-reviewer",
  );
}

type Actions = Awaited<ReturnType<typeof loadActions>>;

// As 3 actions de equivalences.ts falham do mesmo jeito (upsert/delete
// retorna erro → `{ error }`, nunca lança); um caso por action evita repetir
// o esqueleto "seta serverTableResults, chama a action, confere o retorno".
describe.each([
  {
    action: "confirmEquivalentVerdict",
    tableResults: {
      response_equivalences: { error: { message: "pair upsert boom" } },
    },
    call: (fns: Actions) =>
      fns.confirmEquivalentVerdict(
        "p1",
        "doc1",
        "q1",
        ["r1", "r2"],
        "r1",
        "resposta fundida",
      ),
    expectedError: "pair upsert boom",
    arrange: undefined,
    extraChecks: () => {
      expect(upsertsOn("response_equivalences")).toHaveLength(1);
      expect(upsertsOn("reviews")).toHaveLength(0);
    },
  },
  {
    action: "markLlmEquivalent",
    tableResults: {
      response_equivalences: { error: { message: "llm pair boom" } },
    },
    call: (fns: Actions) =>
      fns.markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1"),
    expectedError: "llm pair boom",
    arrange: undefined,
    extraChecks: undefined,
  },
  {
    action: "unmarkEquivalencePair",
    tableResults: undefined,
    call: (fns: Actions) => fns.unmarkEquivalencePair("p1", "eq1"),
    expectedError: "delete pair boom",
    arrange: () => {
      rpcResults.unmark_response_equivalence = {
        error: { message: "delete pair boom" },
      };
    },
    extraChecks: undefined,
  },
])(
  "$action — falha no upsert/delete",
  ({ tableResults, call, expectedError, arrange, extraChecks }) => {
    it("retorna { error }, não lança", async () => {
      serverTableResults = tableResults;
      arrange?.();
      const fns = await loadActions();

      const result = await call(fns);

      expect(result).toEqual({ error: expectedError });
      extraChecks?.();
    });
  },
);

describe.each([
  {
    action: "confirmEquivalentVerdict",
    call: (fns: Actions) =>
      fns.confirmEquivalentVerdict(
        "p1",
        "doc1",
        "q1",
        ["r1", "r2"],
        "r1",
        "resposta fundida",
      ),
  },
  {
    action: "markLlmEquivalent",
    call: (fns: Actions) =>
      fns.markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1"),
  },
  {
    action: "unmarkEquivalencePair",
    call: (fns: Actions) => fns.unmarkEquivalencePair("p1", "eq1"),
  },
])("$action — falha ao resolver identidade", ({ call }) => {
  it("retorna { error }, não lança nem inicia escrita", async () => {
    mockGetEffectiveMemberId.mockRejectedValueOnce(
      new Error("identity lookup boom"),
    );
    const fns = await loadActions();

    const result = await call(fns);

    expect(result).toEqual({ error: "identity lookup boom" });
    expect(writeCalls).toEqual([]);
  });
});

describe("confirmEquivalentVerdict", () => {
  it("upsert em reviews falha após response_equivalences já gravado → retorna { error }, não lança", async () => {
    serverTableResults = {
      response_equivalences: { error: null },
      reviews: { error: { message: "review upsert boom" } },
    };
    const { confirmEquivalentVerdict } = await loadActions();

    const result = await confirmEquivalentVerdict(
      "p1",
      "doc1",
      "q1",
      ["r1", "r2"],
      "r1",
      "resposta fundida",
    );

    // Documenta o comportamento atual: o par de equivalência já foi
    // persistido quando o upsert de reviews falha (não há rollback), mesmo
    // com a action reportando erro ao client.
    expect(result).toEqual({ error: "review upsert boom" });
    expect(upsertsOn("response_equivalences")).toHaveLength(1);
    expect(upsertsOn("reviews")).toHaveLength(1);
  });

  it("caminho feliz → retorna {} e grava o par canônico (a < b) e o chosen_response_id do gabarito", async () => {
    serverTableResults = {
      response_equivalences: { error: null },
      reviews: { error: null },
    };
    const { confirmEquivalentVerdict } = await loadActions();

    const result = await confirmEquivalentVerdict(
      "p1",
      "doc1",
      "q1",
      ["r2", "r1"],
      "r2",
      "resposta fundida",
    );

    expect(result).toEqual({});
    expect(upsertsOn("response_equivalences")[0]?.payload).toEqual([
      {
        project_id: "p1",
        document_id: "doc1",
        field_name: "q1",
        response_a_id: "r1",
        response_b_id: "r2",
        reviewer_id: "canonical-reviewer",
      },
    ]);
    expect(upsertsOn("reviews")[0]?.payload).toMatchObject({
      project_id: "p1",
      document_id: "doc1",
      field_name: "q1",
      reviewer_id: "canonical-reviewer",
      verdict: "resposta fundida",
      chosen_response_id: "r2",
    });
    expectCanonicalIdentityLookup();
    expectCanonicalAssignmentSync();
  });
});

describe("markLlmEquivalent", () => {
  it("caminho feliz → retorna {}", async () => {
    serverTableResults = { response_equivalences: { error: null } };
    const { markLlmEquivalent } = await loadActions();

    const result = await markLlmEquivalent(
      "p1",
      "doc1",
      "q1",
      "llm1",
      "human1",
    );

    expect(result).toEqual({});
    expect(upsertsOn("response_equivalences")[0]?.payload).toMatchObject({
      project_id: "p1",
      reviewer_id: "canonical-reviewer",
    });
    expectCanonicalIdentityLookup();
  });
});

describe("unmarkEquivalencePair", () => {
  it("caminho feliz → retorna {} e limpa o review do revisor atual para o par", async () => {
    rpcResults.unmark_response_equivalence = {
      data: [{ document_id: "doc1", field_name: "q1" }],
      error: null,
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({});
    expect(rpcCalls).toEqual([
      {
        fn: "unmark_response_equivalence",
        args: {
          p_project_id: "p1",
          p_equivalence_id: "eq1",
          p_reviewer_id: "canonical-reviewer",
        },
      },
    ]);
    expectCanonicalIdentityLookup();
    expectCanonicalAssignmentSync();
  });

  it("RLS filtra o delete → retorna erro sem apagar review nem sincronizar", async () => {
    rpcResults.unmark_response_equivalence = { data: [], error: null };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq-alheia");

    expect(result).toEqual({
      error: "Equivalência não encontrada ou sem permissão para removê-la.",
    });
    expect(writeCalls).toEqual([]);
    expect(mockSyncCompareAssignment).not.toHaveBeenCalled();
  });

  it("RPC aborta a transação → retorna erro e não sincroniza o assignment", async () => {
    rpcResults.unmark_response_equivalence = {
      error: { message: "review delete boom" },
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({ error: "review delete boom" });
    expect(mockSyncCompareAssignment).not.toHaveBeenCalled();
  });
});

// O #499 fez `syncCompareAssignment` lançar (antes o erro do UPDATE caía no
// chão), então o sync só pode ser chamado DEPOIS do commit e fora do try que
// devolve `{ error }`. Se voltar para dentro, uma falha de sync vira um erro
// sobre uma escrita já persistida: a revisora tenta de novo e o retry cai numa
// linha que não existe mais, e a revalidação nem roda.
describe.each([
  {
    action: "confirmEquivalentVerdict",
    arrange: undefined,
    call: (fns: Actions) =>
      fns.confirmEquivalentVerdict(
        "p1",
        "doc1",
        "q1",
        ["r1", "r2"],
        "r1",
        "resposta fundida",
      ),
  },
  {
    action: "unmarkEquivalencePair",
    arrange: () => {
      rpcResults.unmark_response_equivalence = {
        data: [{ document_id: "doc1", field_name: "q1" }],
        error: null,
      };
    },
    call: (fns: Actions) => fns.unmarkEquivalencePair("p1", "eq1"),
  },
])("$action — falha do sync pós-commit", ({ arrange, call }) => {
  it("retorna {} e só loga: a escrita já foi persistida", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSyncCompareAssignment.mockRejectedValueOnce(new Error("sync boom"));
    arrange?.();
    const fns = await loadActions();

    const result = await call(fns);

    expect(result).toEqual({});
    expect(mockSyncCompareAssignment).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("sync boom");
    errorSpy.mockRestore();
  });
});
