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
// syncCompareAssignment é best-effort e tem seu próprio teste dedicado
// (compare-sync.ts); aqui só interessa não deixá-lo derrubar a action. O mock
// é um vi.fn justamente para poder REJEITAR: enquanto era um `async () => {}`
// fixo, o teste que dizia cobrir esse contrato era vácuo — nunca exercitou a
// falha que o #499 tornou possível ao fazer o sync lançar.
const { mockSyncCompareAssignment } = vi.hoisted(() => ({
  mockSyncCompareAssignment: vi.fn(async () => {}),
}));
vi.mock("@/lib/compare-sync", () => ({
  syncCompareAssignment: mockSyncCompareAssignment,
}));

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  rpcResults = {};
  serverTableResults = undefined;
  mockSyncCompareAssignment.mockClear();
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
  it("caminho feliz → retorna {} e delega o delete do review à RPC", async () => {
    rpcResults.remove_response_equivalence = {
      data: [{ document_id: "doc1", field_name: "q1" }],
      error: null,
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({});
    expect(rpcCalls).toEqual([
      {
        fn: "remove_response_equivalence",
        args: { p_project_id: "p1", p_equivalence_id: "eq1" },
      },
    ]);
    // O par e o veredito saem na mesma transação da RPC. Um delete de
    // `reviews` pelo client aqui significaria que a escrita voltou a ser
    // parcial — a metade que podia falhar sozinha.
    expect(
      writeCalls.some((c) => c.op === "delete" && c.table === "reviews"),
    ).toBe(false);
    expect(mockSyncCompareAssignment).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      "doc1",
      "canonical-reviewer",
    );
  });

  // Conjunto vazio é o que a RPC devolve tanto para linha inexistente quanto
  // para autoridade que não bate. Antes deste guard a action retornava `{}` e
  // a revisora via "desfeito" sobre nada removido (classe do #178).
  it("RPC filtra por autoridade → retorna { error }, não sucesso silencioso", async () => {
    rpcResults.remove_response_equivalence = { data: [], error: null };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq-alheia");

    expect(result).toEqual({
      error: "Equivalência não encontrada ou sem permissão para removê-la.",
    });
    expect(writeCalls).toEqual([]);
    expect(mockSyncCompareAssignment).not.toHaveBeenCalled();
  });

  it("RPC aborta a transação → retorna { error } e não sincroniza", async () => {
    rpcResults.remove_response_equivalence = {
      error: { message: "review delete boom" },
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({ error: "review delete boom" });
    expect(mockSyncCompareAssignment).not.toHaveBeenCalled();
  });

  // O sync roda DEPOIS do commit da RPC e fora do try que devolve `{ error }`.
  // Se voltar para dentro, uma falha de sync vira "falha ao desfazer" sobre uma
  // escrita já persistida: a revisora tenta de novo sobre uma linha que não
  // existe mais, e a revalidação nem roda.
  it("falha do sync pós-commit → retorna {} e só loga", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSyncCompareAssignment.mockRejectedValueOnce(new Error("sync boom"));
    rpcResults.remove_response_equivalence = {
      data: [{ document_id: "doc1", field_name: "q1" }],
      error: null,
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({});
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("sync boom");
    errorSpy.mockRestore();
  });
});
