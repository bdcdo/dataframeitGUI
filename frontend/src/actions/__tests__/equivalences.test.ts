import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";

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
const {
  mockSyncCompareAssignment,
  mockPropagate,
  afterCallbacks,
} = vi.hoisted(() => ({
  mockSyncCompareAssignment: vi.fn(async () => {}),
  mockPropagate: vi.fn(async () => {}),
  afterCallbacks: [] as Array<() => unknown>,
}));
vi.mock("@/lib/compare-sync", () => ({
  syncCompareAssignment: mockSyncCompareAssignment,
}));
// A equivalência vale no projeto inteiro: reconciliar e ressincronizar os
// outros documentos é trabalho de `after()`, depois da resposta ao clique. O
// mock guarda o callback para o teste conferir o que foi agendado.
vi.mock("next/server", () => ({
  after: (callback: () => unknown) => {
    afterCallbacks.push(callback);
  },
}));
vi.mock("@/lib/value-equivalence-effects", () => ({
  propagateValueEquivalenceChange: mockPropagate,
}));

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  rpcResults = {};
  serverTableResults = undefined;
  mockSyncCompareAssignment.mockClear();
  mockPropagate.mockClear();
  afterCallbacks.length = 0;
});

async function loadActions() {
  return await import("@/actions/equivalences");
}

function upsertsOn(table: string) {
  return writeCalls.filter((c) => c.op === "upsert" && c.table === table);
}

type Actions = Awaited<ReturnType<typeof loadActions>>;

// A action lê, antes de desfazer, as equivalências do projeto (a alvo está
// entre elas) e o campo, para calcular a classe de antes da remoção.
const TARGET_EQUIVALENCE_ROW = {
  id: "eq1", field_name: "q1", field_hash: "aaaaaaaaaaaa", value_a: "NI", value_b: "N/A", reviewer_id: "canonical-reviewer",
};
const Q1_FIELD = {
  id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "text", options: null, description: "", hash: "aaaaaaaaaaaa",
};
const TARGET_EQUIVALENCE: TableResults = {
  value_equivalences: {
    data: [TARGET_EQUIVALENCE_ROW, { ...TARGET_EQUIVALENCE_ROW, id: "eq2", value_a: "N/A", value_b: "não se aplica" }],
  },
  projects: { data: { pydantic_fields: [Q1_FIELD] } },
};

// As 3 actions de equivalences.ts falham do mesmo jeito (upsert/delete
// retorna erro → `{ error }`, nunca lança); um caso por action evita repetir
// o esqueleto "seta serverTableResults, chama a action, confere o retorno".
describe.each([
  {
    action: "confirmEquivalentVerdict",
    tableResults: undefined,
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
    tableResults: undefined,
    call: (fns: Actions) =>
      fns.markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1"),
    expectedError: "llm pair boom",
    extraChecks: undefined,
    rpcError: "llm pair boom",
  },
  {
    action: "unmarkEquivalencePair",
    tableResults: TARGET_EQUIVALENCE,
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
        ? "remove_value_equivalence"
        : "record_value_equivalences";
      rpcResults[rpcName] = { error: { message: rpcError } };
    }
    const fns = await loadActions();

    const result = await call(fns);

    expect(result).toEqual({ error: expectedError });
    extraChecks?.();
  });
});

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/equivalences");
}, 30_000);

describe("confirmEquivalentVerdict", () => {
  it("upsert em reviews falha após a equivalência já gravada → retorna { error }, não lança", async () => {
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

  it("caminho feliz → retorna {}, grava a equivalência a partir das respostas e o chosen_response_id do gabarito", async () => {
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
    // Uma linha por resposta além do gabarito, ligada a ele: os VALORES saem
    // das respostas no banco, e o hash, do schema atual — o cliente não os
    // escolhe.
    expect(rpcCalls[0]).toEqual({
      fn: "record_value_equivalences",
      args: { p_rows: [{
        project_id: "p1",
        document_id: "doc1",
        field_name: "q1",
        response_a_id: "r2",
        response_b_id: "r1",
        reviewer_id: "canonical-reviewer",
        source: "comparacao",
      }] },
    });
    // O documento atual sincroniza já; os demais com os mesmos valores, em
    // `after()`.
    expect(mockSyncCompareAssignment).toHaveBeenCalledOnce();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(mockPropagate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      changes: [{ fieldName: "q1", responseIds: ["r2", "r1"] }],
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

describe("confirmEquivalentVerdict: falha do sync pós-commit", () => {
  // O sync roda depois de gravar par e review, fora do try que devolve
  // `{ error }`. Se a falha dele subisse, o client refaria uma escrita já
  // persistida e a revalidação nem rodaria.
  it("grava par e veredito, retorna {} e só loga", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSyncCompareAssignment.mockRejectedValueOnce(new Error("sync boom"));
    serverTableResults = {
      reviews: { error: null },
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

    expect(result).toEqual({});
    expect(rpcCalls).toHaveLength(1);
    expect(upsertsOn("reviews")).toHaveLength(1);
    expect(mockSyncCompareAssignment).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("sync boom");
    errorSpy.mockRestore();
  });
});

describe("confirmEquivalentVerdict: gabarito fora das opções atuais", () => {
  it("recusa antes de gravar par ou veredito", async () => {
    serverTableResults = {
      projects: { data: { pydantic_fields: [{
        id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "single",
        options: ["Sim", "Não"], description: "", hash: "aaaaaaaaaaaa",
      }] } },
      reviews: { error: null },
    };
    const { confirmEquivalentVerdict } = await loadActions();

    const result = await confirmEquivalentVerdict({
      projectId: "p1", documentId: "doc1", fieldName: "q1",
      responseIds: ["r1", "r2"], gabaritoId: "r1", verdictDisplay: "Talvez",
    });

    expect(result.error).toMatch(/não está mais no formulário/);
    expect(rpcCalls).toHaveLength(0);
    expect(upsertsOn("reviews")).toHaveLength(0);
  });

  it("gabarito nas opções atuais grava", async () => {
    serverTableResults = {
      projects: { data: { pydantic_fields: [{
        id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "single",
        options: ["Sim", "Não"], description: "", hash: "aaaaaaaaaaaa",
      }] } },
      reviews: { error: null },
    };
    const { confirmEquivalentVerdict } = await loadActions();

    const result = await confirmEquivalentVerdict({
      projectId: "p1", documentId: "doc1", fieldName: "q1",
      responseIds: ["r1", "r2"], gabaritoId: "r1", verdictDisplay: "Sim",
    });

    expect(result).toEqual({});
    expect(upsertsOn("reviews")).toHaveLength(1);
  });
});

describe("markLlmEquivalent", () => {
  it("caminho feliz → retorna {}", async () => {
    const { markLlmEquivalent } = await loadActions();

    const result = await markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1");

    expect(result).toEqual({});
    expect(rpcCalls).toEqual([{
      fn: "record_value_equivalences",
      args: { p_rows: [{
        project_id: "p1",
        document_id: "doc1",
        field_name: "q1",
        response_a_id: "human1",
        response_b_id: "llm1",
        reviewer_id: "canonical-reviewer",
        source: "llm_insights",
      }] },
    }]);
    expect(afterCallbacks).toHaveLength(1);
  });
});

describe("unmarkEquivalencePair", () => {
  it("caminho feliz → retorna {}, não apaga veredito e agenda a classe de ANTES da remoção", async () => {
    serverTableResults = structuredClone(TARGET_EQUIVALENCE);
    rpcResults.remove_value_equivalence = {
      data: [{ field_name: "q1" }],
      error: null,
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({});
    expect(rpcCalls).toEqual([
      {
        fn: "remove_value_equivalence",
        args: { p_project_id: "p1", p_equivalence_id: "eq1" },
      },
    ]);
    // Desfazer não apaga veredito (decisão de produto da equivalência por
    // valor): nem a action nem a RPC tocam em `reviews`.
    expect(writeCalls.some((c) => c.table === "reviews")).toBe(false);
    expect(mockSyncCompareAssignment).not.toHaveBeenCalled();
    // A classe antiga inteira (NI = N/A = não se aplica), e não só as duas
    // pontas: é onde a divergência pode reaparecer.
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(mockPropagate).toHaveBeenCalledOnce();
    const call = (mockPropagate.mock.calls[0] as unknown as [{ changes: Array<{ valueKeys: Set<string>; fieldName: string }> }])[0].changes[0];
    expect(call.fieldName).toBe("q1");
    expect([...call.valueKeys].sort()).toEqual(
      [JSON.stringify("n/a"), JSON.stringify("nao se aplica"), JSON.stringify("ni")].sort(),
    );
  });

  // Na Comparação, quem desfaz está num documento: o assignment dele ali
  // reflete a mudança já, sem esperar a propagação.
  it("com documento, sincroniza já o assignment de quem desfez nele", async () => {
    serverTableResults = structuredClone(TARGET_EQUIVALENCE);
    rpcResults.remove_value_equivalence = { data: [{ field_name: "q1" }], error: null };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1", "doc1");

    expect(result).toEqual({});
    expect(mockSyncCompareAssignment).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), "p1", "doc1", "canonical-reviewer",
    );
  });

  // Conjunto vazio é o que a RPC devolve tanto para linha inexistente quanto
  // para autoridade que não bate. Antes deste guard a action retornava `{}` e
  // a revisora via "desfeito" sobre nada removido (classe do #178).
  it("RPC filtra por autoridade → retorna { error }, não sucesso silencioso", async () => {
    serverTableResults = structuredClone(TARGET_EQUIVALENCE);
    rpcResults.remove_value_equivalence = { data: [], error: null };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq-alheia");

    expect(result).toEqual({
      error: "Equivalência não encontrada ou sem permissão para removê-la.",
    });
    expect(writeCalls).toEqual([]);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("equivalência inexistente → { error } sem chamar a RPC", async () => {
    serverTableResults = { value_equivalences: { data: [] } };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq-sumiu");

    expect(result).toEqual({
      error: "Equivalência não encontrada ou sem permissão para removê-la.",
    });
    expect(rpcCalls).toEqual([]);
  });

  it("RPC aborta a transação → retorna { error } e não agenda propagação", async () => {
    serverTableResults = structuredClone(TARGET_EQUIVALENCE);
    rpcResults.remove_value_equivalence = {
      error: { message: "remove boom" },
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({ error: "remove boom" });
    expect(afterCallbacks).toHaveLength(0);
  });
});

describe("loadEquivalenceUsage", () => {
  it("por classe, os documentos em que ela funde respostas da versão atual", async () => {
    serverTableResults = {
      responses: { data: [
        { id: "r1", document_id: "d1", answer_field_hashes: { q1: "aaaaaaaaaaaa" }, value: "NI", documents: { title: "Doc 1", external_id: null } },
        { id: "r2", document_id: "d1", answer_field_hashes: { q1: "aaaaaaaaaaaa" }, value: "N/A", documents: { title: "Doc 1", external_id: null } },
        { id: "r3", document_id: "d2", answer_field_hashes: { q1: "bbbbbbbbbbbb" }, value: "NI", documents: { title: "Doc 2", external_id: null } },
        { id: "r4", document_id: "d2", answer_field_hashes: { q1: "aaaaaaaaaaaa" }, value: "N/A", documents: { title: "Doc 2", external_id: null } },
      ] },
      value_equivalences: { data: [TARGET_EQUIVALENCE_ROW] },
      projects: { data: { pydantic_fields: [Q1_FIELD] } },
    };
    const { loadEquivalenceUsage } = await loadActions();

    const result = await loadEquivalenceUsage("p1", "q1");

    // d2 tem um dos lados respondido a outra versão da pergunta: não funde.
    expect(result).toEqual({ usage: { [JSON.stringify("n/a")]: [{ id: "d1", title: "Doc 1" }] } });
  });

  it("nome de campo que não é identificador vira { error }, sem query", async () => {
    serverTableResults = { value_equivalences: { data: [] }, projects: { data: { pydantic_fields: [] } } };
    const { loadEquivalenceUsage } = await loadActions();

    const result = await loadEquivalenceUsage("p1", "q1,answers");

    expect(result.error).toMatch(/nome de campo inválido/);
  });
});
