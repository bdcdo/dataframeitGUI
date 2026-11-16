import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";

// Cobertura de regressão para o bug relatado na issue #366 ("não tá indo a
// resposta da equivalencia"): antes da PR #362, estas actions lançavam Error
// (mascarado pelo Next 16 em produção) e o client fazia escrita otimista antes
// de aguardar o resultado. Hoje retornam `{ error? }`; estes testes travam
// esse contrato — nenhuma das três pode voltar a lançar em vez de retornar.
import {
  makeFilterAwareSupabaseMock,
  type QueryError,
  type WriteCall,
  type RpcCall,
  type ReadCall,
} from "@/test-utils/supabase-mock";

let writeCalls: WriteCall[];
let tableData: Record<string, unknown[]>;
let queryErrors: Record<string, QueryError | null>;
let readCalls: ReadCall[];
let rpcCalls: RpcCall[];
let rpcResults: Record<string, {
  data?: unknown;
  error?: { message: string; code?: string } | null;
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
    makeFilterAwareSupabaseMock({
      tableData,
      queryErrors,
      writeCalls,
      readCalls,
      rpcCalls,
      rpcResults,
      projectColumns: true,
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
  readCalls = [];
  rpcResults = {};
  tableData = { projects: [{ id: "p1", pydantic_fields: [Q1_FIELD] }] };
  queryErrors = {};
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

const TARGET_EQUIVALENCE_ROW = {
  id: "eq1", project_id: "p1", field_name: "q1", field_hash: "aaaaaaaaaaaa", value_a: "NI", value_b: "N/A", reviewer_id: "canonical-reviewer",
};
const Q1_FIELD = {
  id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "text", options: null, description: "", hash: "aaaaaaaaaaaa",
};

const MARK_FAILED = "Não foi possível marcar as respostas como equivalentes. Tente novamente.";

// As 3 actions de equivalences.ts falham do mesmo jeito (upsert/delete
// retorna erro → `{ error }`, nunca lança); um caso por action evita repetir
// o esqueleto "prepara tabela, chama a action, confere o retorno".
describe.each([
  {
    action: "confirmEquivalentVerdict",
    call: (fns: Actions) =>
      fns.confirmEquivalentVerdict({
        projectId: "p1",
        documentId: "doc1",
        fieldName: "q1",
        responseIds: ["r1", "r2"],
        gabaritoId: "r1",
        verdictDisplay: "resposta fundida",
      }),
    expectedError: MARK_FAILED,
    extraChecks: () => {
      expect(rpcCalls).toHaveLength(1);
      expect(upsertsOn("reviews")).toHaveLength(0);
    },
    rpcError: "pair upsert boom",
  },
  {
    action: "markLlmEquivalent",
    call: (fns: Actions) =>
      fns.markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1"),
    expectedError: MARK_FAILED,
    extraChecks: undefined,
    rpcError: "llm pair boom",
  },
  {
    action: "unmarkEquivalencePair",
    call: (fns: Actions) => fns.unmarkEquivalencePair("p1", "eq1"),
    expectedError: "Não foi possível desfazer a equivalência. Tente novamente.",
    extraChecks: undefined,
    rpcError: "delete pair boom",
  },
])("$action — falha no upsert/delete", ({ action, call, expectedError, extraChecks, rpcError }) => {
  it("retorna { error }, não lança", async () => {
    if (rpcError) {
      const rpcName = action === "unmarkEquivalencePair"
        ? "remove_value_equivalence"
        : "record_value_equivalences";
      rpcResults[rpcName] = { error: { message: rpcError } };
    }
    const fns = await loadActions();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await call(fns);

    // O texto do Postgres vai para o log; o toast recebe a copy pt-BR (#502).
    expect(result).toEqual({ error: copyWithRef(expectedError) });
    expect(errorSpy).toHaveBeenCalledWith(
      loggedLine(/\[equivalences\] .* falhou/, { message: rpcError }),
    );
    errorSpy.mockRestore();
    extraChecks?.();
  });
});

// A guarda de `record_value_equivalences` contra resposta a outra versão da
// pergunta levanta copy pt-BR própria (23514): ela chega ao toast como veio.
describe("record_value_equivalences — guarda de versão da pergunta", () => {
  it.each([
    ["confirmEquivalentVerdict", (fns: Actions) =>
      fns.confirmEquivalentVerdict({
        projectId: "p1",
        documentId: "doc1",
        fieldName: "q1",
        responseIds: ["r1", "r2"],
        gabaritoId: "r1",
        verdictDisplay: "resposta fundida",
      })],
    ["markLlmEquivalent", (fns: Actions) =>
      fns.markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1")],
  ])("%s devolve a copy da RPC", async (_name, call) => {
    const guard =
      "Uma das respostas foi dada a outra versão da pergunta e não pode ser marcada como equivalente.";
    rpcResults.record_value_equivalences = { error: { message: guard, code: "23514" } };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await call(await loadActions());

    expect(result).toEqual({ error: guard });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("record_value_equivalences — outro 23514", () => {
  // CHECK da tabela (ordem canônica, origem) é falha real: vai ao log.
  it("vira a copy pt-BR com código e loga o texto", async () => {
    rpcResults.record_value_equivalences = {
      error: {
        message: 'new row for relation "value_equivalences" violates check constraint "value_equivalences_canonical_order"',
        code: "23514",
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await (await loadActions()).markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1");

    expect(result).toEqual({ error: copyWithRef(MARK_FAILED) });
    expect(errorSpy).toHaveBeenCalledWith(
      loggedLine("[equivalences] equivalência do LLM falhou", { code: "23514" }),
    );
    errorSpy.mockRestore();
  });
});

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/equivalences");
}, 30_000);

describe("confirmEquivalentVerdict", () => {
  it("upsert em reviews falha após a equivalência já gravada → retorna { error }, não lança", async () => {
    queryErrors["reviews:upsert"] = { message: "review upsert boom" };
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
    expect(result).toEqual({ error: copyWithRef(MARK_FAILED) });
    expect(rpcCalls).toHaveLength(1);
    expect(upsertsOn("reviews")).toHaveLength(1);
  });

  it("caminho feliz → retorna {}, grava a equivalência a partir das respostas e o chosen_response_id do gabarito", async () => {
    rpcResults.record_value_equivalences = {
      data: [{ field_name: "q1", value_a: "N/A", value_b: "NI" }],
      error: null,
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
    // A propagação usa o que a RPC devolveu, sem reler as respostas.
    expect(mockPropagate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      changes: [{ fieldName: "q1", values: ["N/A", "NI"] }],
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
    tableData = {
      projects: [{ id: "p1", pydantic_fields: [{
        id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "single",
        options: ["Sim", "Não"], description: "", hash: "aaaaaaaaaaaa",
      }] }],
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
    tableData = {
      projects: [{ id: "p1", pydantic_fields: [{
        id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "single",
        options: ["Sim", "Não"], description: "", hash: "aaaaaaaaaaaa",
      }] }],
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
    // O par de valores já existia: nada novo a propagar.
    expect(afterCallbacks).toHaveLength(0);
  });

  it("par de valores novo agenda a propagação", async () => {
    rpcResults.record_value_equivalences = {
      data: [{ field_name: "q1", value_a: "humano", value_b: "llm" }],
      error: null,
    };
    const { markLlmEquivalent } = await loadActions();

    await markLlmEquivalent("p1", "doc1", "q1", "llm1", "human1");

    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(mockPropagate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      changes: [{ fieldName: "q1", values: ["humano", "llm"] }],
    });
  });
});

describe("unmarkEquivalencePair", () => {
  it("caminho feliz → retorna {}, não apaga veredito e agenda a classe de ANTES da remoção", async () => {
    rpcResults.remove_value_equivalence = {
      data: [{ field_name: "q1", field_hash: "aaaaaaaaaaaa", value_a: "NI", value_b: "N/A" }],
      error: null,
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({});
    // Sem leitura antes de remover: a RPC devolve o que separou.
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
    // A equivalência desfeita vai junto, para a propagação calcular a classe
    // antiga, onde a divergência pode reaparecer.
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(mockPropagate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      changes: [{
        fieldName: "q1",
        values: ["NI", "N/A"],
        removed: { id: "eq1", reviewer_id: null, field_name: "q1", field_hash: "aaaaaaaaaaaa", value_a: "NI", value_b: "N/A" },
      }],
    });
  });

  // Na Comparação, quem desfaz está num documento: o assignment dele ali
  // reflete a mudança já, sem esperar a propagação.
  it("com documento, sincroniza já o assignment de quem desfez nele", async () => {
    rpcResults.remove_value_equivalence = {
      data: [{ field_name: "q1", field_hash: "aaaaaaaaaaaa", value_a: "NI", value_b: "N/A" }],
      error: null,
    };
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
    rpcResults.remove_value_equivalence = { data: [], error: null };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq-alheia");

    expect(result).toEqual({
      error: "Equivalência não encontrada ou sem permissão para removê-la.",
    });
    expect(writeCalls).toEqual([]);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("RPC aborta a transação → retorna { error } e não agenda propagação", async () => {
    rpcResults.remove_value_equivalence = {
      error: { message: "remove boom" },
    };
    const { unmarkEquivalencePair } = await loadActions();

    const result = await unmarkEquivalencePair("p1", "eq1");

    expect(result).toEqual({
      error: copyWithRef("Não foi possível desfazer a equivalência. Tente novamente."),
    });
    expect(afterCallbacks).toHaveLength(0);
  });
});

describe("loadEquivalenceUsage", () => {
  it("por classe, os documentos em que ela funde respostas da versão atual", async () => {
    tableData = {
      responses: [
        { id: "r1", project_id: "p1", is_latest: true, "answers->q1": "NI", "documents.excluded_at": null, document_id: "d1", answer_field_hashes: { q1: "aaaaaaaaaaaa" }, documents: { title: "Doc 1", external_id: null } },
        { id: "r2", project_id: "p1", is_latest: true, "answers->q1": "N/A", "documents.excluded_at": null, document_id: "d1", answer_field_hashes: { q1: "aaaaaaaaaaaa" }, documents: { title: "Doc 1", external_id: null } },
        { id: "r3", project_id: "p1", is_latest: true, "answers->q1": "NI", "documents.excluded_at": null, document_id: "d2", answer_field_hashes: { q1: "bbbbbbbbbbbb" }, documents: { title: "Doc 2", external_id: null } },
        { id: "r4", project_id: "p1", is_latest: true, "answers->q1": "N/A", "documents.excluded_at": null, document_id: "d2", answer_field_hashes: { q1: "aaaaaaaaaaaa" }, documents: { title: "Doc 2", external_id: null } },
        { id: "r5", project_id: "other", is_latest: true, "answers->q1": "N/A", "documents.excluded_at": null, document_id: "d3", answer_field_hashes: { q1: "aaaaaaaaaaaa" }, documents: { title: "Fora do projeto", external_id: null } },
        { id: "r6", project_id: "p1", is_latest: false, "answers->q1": "N/A", "documents.excluded_at": null, document_id: "d3", answer_field_hashes: { q1: "aaaaaaaaaaaa" }, documents: { title: "Fora da versão", external_id: null } },
        { id: "r7", project_id: "p1", is_latest: true, "answers->q1": "NI", "documents.excluded_at": null, document_id: "d3", answer_field_hashes: { q1: "aaaaaaaaaaaa" }, documents: { title: "Só um lado válido", external_id: null } },
      ],
      value_equivalences: [TARGET_EQUIVALENCE_ROW],
      projects: [{ id: "p1", pydantic_fields: [Q1_FIELD] }],
    };
    const { loadEquivalenceUsage } = await loadActions();

    const result = await loadEquivalenceUsage("p1", "q1");

    // d2 tem um dos lados respondido a outra versão da pergunta: não funde.
    expect(result).toEqual({ usage: { [JSON.stringify("n/a")]: [{ id: "d1", title: "Doc 1" }] } });
    expect(readCalls.find((call) => call.table === "responses")?.filters).toEqual([
      ["eq", "project_id", "p1"],
      ["eq", "is_latest", true],
      ["not.is", "answers->q1", null],
      ["is", "documents.excluded_at", null],
    ]);
  });

  it("nome de campo que não é identificador vira { error }, sem query", async () => {
    tableData = { value_equivalences: [], projects: [{ id: "p1", pydantic_fields: [] }] };
    const { loadEquivalenceUsage } = await loadActions();

    const result = await loadEquivalenceUsage("p1", "q1,answers");

    expect(result.error).toEqual(
      copyWithRef("Não foi possível carregar onde a equivalência se aplica. Tente novamente."),
    );
  });
});
