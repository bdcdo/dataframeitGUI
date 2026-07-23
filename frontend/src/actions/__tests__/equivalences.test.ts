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
  type RpcCall,
} from "./supabase-mock";

let writeCalls: WriteCall[];
let serverTableResults: TableResults | undefined;
let rpcCalls: RpcCall[];
let rpcResults: Record<string, {
  data?: unknown;
  error?: { message: string } | null;
}>;

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  resolveProjectMemberActor: async () => ({
    ok: true,
    user: { id: "linked-account" },
    memberUserId: "canonical-reviewer",
  }),
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
  syncCompareAssignment: async () => {},
}));

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  rpcResults = {};
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
      response_equivalences: { error: null },
    },
    call: (fns: Actions) =>
      fns.confirmEquivalentVerdict({
        projectId: "p1",
        documentId: "doc1",
        fieldName: "q1",
        responseIds: ["r1", "r2"],
        gabaritoId: "r1",
        verdictDisplay: "resposta fundida",
      }),
    expectedError: "pair upsert boom",
    extraChecks: () => {
      expect(rpcCalls).toHaveLength(1);
      expect(upsertsOn("reviews")).toHaveLength(0);
    },
    rpcError: "pair upsert boom",
  },
  {
    action: "markLlmEquivalent",
    tableResults: {
      response_equivalences: { error: null },
    },
    call: (fns: Actions) =>
      fns.markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1"),
    expectedError: "llm pair boom",
    extraChecks: undefined,
    rpcError: "llm pair boom",
  },
  {
    action: "unmarkEquivalencePair",
    tableResults: undefined,
    call: (fns: Actions) => fns.unmarkEquivalencePair("p1", "eq1"),
    expectedError: "delete pair boom",
    extraChecks: undefined,
    rpcError: "delete pair boom",
  },
])("$action — falha no upsert/delete", ({ action, tableResults, call, expectedError, extraChecks, rpcError }) => {
  it("retorna { error }, não lança", async () => {
    serverTableResults = tableResults;
    if (rpcError) {
      const rpcName = action === "unmarkEquivalencePair"
        ? "remove_response_equivalence"
        : "record_response_equivalences";
      rpcResults[rpcName] = { error: { message: rpcError } };
    }
    const fns = await loadActions();

    const result = await call(fns);

    expect(result).toEqual({ error: expectedError });
    extraChecks?.();
  });
});

describe("confirmEquivalentVerdict", () => {
  it("upsert em reviews falha após response_equivalences já gravado → retorna { error }, não lança", async () => {
    serverTableResults = {
      reviews: { error: { message: "review upsert boom" } },
    };
    const { confirmEquivalentVerdict } = await loadActions();

    const result = await confirmEquivalentVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      responseIds: ["r1", "r2"],
      gabaritoId: "r1",
      verdictDisplay: "resposta fundida",
    });

    // Documenta o comportamento atual: o par de equivalência já foi
    // persistido quando o upsert de reviews falha (não há rollback), mesmo
    // com a action reportando erro ao client.
    expect(result).toEqual({ error: "review upsert boom" });
    expect(rpcCalls).toHaveLength(1);
    expect(upsertsOn("reviews")).toHaveLength(1);
  });

  it("caminho feliz → retorna {} e grava o par canônico (a < b) e o chosen_response_id do gabarito", async () => {
    serverTableResults = {
      reviews: { error: null },
    };
    const { confirmEquivalentVerdict } = await loadActions();

    const result = await confirmEquivalentVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      responseIds: ["r2", "r1"],
      gabaritoId: "r2",
      verdictDisplay: "resposta fundida",
    });

    expect(result).toEqual({});
    expect(rpcCalls[0]).toEqual({
      fn: "record_response_equivalences",
      args: { p_rows: [{
        project_id: "p1",
        document_id: "doc1",
        field_name: "q1",
        response_a_id: "r1",
        response_b_id: "r2",
        reviewer_id: "canonical-reviewer",
      }] },
    });
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
    const { markLlmEquivalent } = await loadActions();

    const result = await markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1");

    expect(result).toEqual({});
    expect(rpcCalls).toHaveLength(1);
  });
});

describe("unmarkEquivalencePair", () => {
  it("caminho feliz → retorna {} e limpa o review do revisor atual para o par", async () => {
    serverTableResults = {
      reviews: { error: null },
    };
    rpcResults.remove_response_equivalence = {
      data: [{ document_id: "doc1", field_name: "q1" }],
      error: null,
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({});
    expect(
      writeCalls.some((c) => c.op === "delete" && c.table === "reviews"),
    ).toBe(true);
  });
});
