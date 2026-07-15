import { describe, it, expect, beforeEach, vi } from "vitest";

// Cobertura de regressão para o bug relatado na issue #366 ("não tá indo a
// resposta da equivalencia"): antes da PR #362, estas actions lançavam Error
// (mascarado pelo Next 16 em produção) e o client fazia escrita otimista antes
// de aguardar o resultado. Hoje retornam `{ error? }`; estes testes travam
// esse contrato — nenhuma das três pode voltar a lançar em vez de retornar.
import {
  makeSupabaseMock,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

let writeCalls: WriteCall[];
let serverTableResults: TableResults | undefined;
const syncCompareAssignment = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "linked-account" }),
  getEffectiveMemberId: async () => "canonical-reviewer",
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({ tableResults: serverTableResults, writeCalls }),
}));
// syncCompareAssignment é best-effort e teria seu próprio teste dedicado
// (compare-sync.ts); aqui só interessa não deixá-lo derrubar a action.
vi.mock("@/lib/compare-sync", () => ({
  syncCompareAssignment,
}));

beforeEach(() => {
  syncCompareAssignment.mockClear();
  writeCalls = [];
  serverTableResults = undefined;
});

async function loadActions() {
  return await import("@/actions/equivalences");
}

function upsertsOn(table: string) {
  return writeCalls.filter((c) => c.op === "upsert" && c.table === table);
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
    extraChecks: undefined,
  },
  {
    action: "unmarkEquivalencePair",
    tableResults: {
      response_equivalences: [
        { data: { document_id: "doc1", field_name: "q1" } },
        { error: { message: "delete pair boom" } },
      ],
    },
    call: (fns: Actions) => fns.unmarkEquivalencePair("p1", "eq1"),
    expectedError: "delete pair boom",
    extraChecks: undefined,
  },
])("$action — falha no upsert/delete", ({ tableResults, call, expectedError, extraChecks }) => {
  it("retorna { error }, não lança", async () => {
    serverTableResults = tableResults;
    const fns = await loadActions();

    const result = await call(fns);

    expect(result).toEqual({ error: expectedError });
    extraChecks?.();
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
  });
});

describe("markLlmEquivalent", () => {
  it("caminho feliz → retorna {}", async () => {
    serverTableResults = { response_equivalences: { error: null } };
    const { markLlmEquivalent } = await loadActions();

    const result = await markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1");

    expect(result).toEqual({});
    expect(upsertsOn("response_equivalences")).toHaveLength(1);
    expect(upsertsOn("response_equivalences")[0]?.payload).toMatchObject({
      reviewer_id: "canonical-reviewer",
    });
  });
});

describe("unmarkEquivalencePair", () => {
  it("caminho feliz → retorna {} e limpa o review do revisor atual para o par", async () => {
    serverTableResults = {
      response_equivalences: [
        { data: { document_id: "doc1", field_name: "q1" } },
        { error: null },
      ],
      reviews: { error: null },
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({});
    expect(
      writeCalls.some((c) => c.op === "delete" && c.table === "reviews"),
    ).toBe(true);
    expect(syncCompareAssignment).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      "doc1",
      "canonical-reviewer",
    );
  });
});
