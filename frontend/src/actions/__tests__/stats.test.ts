import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";

// Caracterização das 10 funções resolve/reopen de stats.ts (5 pares, sobre 5
// tabelas) — nenhuma tinha teste antes do #385. O objetivo aqui não é repetir
// as 4 asserções por tabela: um par (resolveNote/reopenNote) é coberto em
// detalhe (sucesso, erro do Supabase, not-found no reopen); o guard de
// withResolutionAction é testado uma vez (é idêntico nas 10); as demais 8
// funções ganham 1 teste de fumaça de caminho feliz cada, o suficiente para
// pegar regressão na migração pro wrapper.
import { makeFilterAwareSupabaseMock, type QueryError, type WriteCall } from "@/test-utils/supabase-mock";
import { resolutionFixture } from "@/lib/__tests__/error-resolution-fixture";
import type { ErrorDecision } from "@/lib/error-resolution";

let tableData: Record<string, unknown[]>;
let queryErrors: Record<string, QueryError>;
let writeCalls: WriteCall[];

function resetFixtures(rows: Record<string, unknown[]> = {}) {
  tableData = rows;
  queryErrors = {};
  writeCalls = [];
}

const hoisted = vi.hoisted(() => ({
  rpc: vi.fn(),
  revalidate: vi.fn(),
  getUser: vi.fn<() => Promise<{ id: string } | null>>(async () => ({
    id: "user1",
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => hoisted.revalidate(...args) }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: () => hoisted.getUser(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({
    ...makeFilterAwareSupabaseMock({ tableData, queryErrors, writeCalls, projectColumns: true }),
    rpc: hoisted.rpc,
  }),
}));

beforeEach(() => {
  resetFixtures();
  hoisted.rpc.mockReset();
  hoisted.revalidate.mockReset();
  hoisted.getUser.mockResolvedValue({ id: "user1" });
});

type Stats = typeof import("@/actions/stats");

async function loadStats() {
  return await import("@/actions/stats");
}

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/stats");
}, 30_000);

describe("withResolutionAction — guard (via resolveNote, idêntico nas 10 funções)", () => {
  it("não autenticado → error, sem insert", async () => {
    hoisted.getUser.mockResolvedValueOnce(null);
    const { resolveNote } = await loadStats();

    const r = await resolveNote("p1", "resp1", "nota");

    expect(r).toEqual({ success: false, error: "Não autenticado" });
    expect(writeCalls).toHaveLength(0);
  });
});

describe("withResolutionAction — exceção na ação", () => {
  // O texto em inglês vai ao log com o code; o toast recebe a copy (#502).
  it("vira copy pt-BR com código", async () => {
    hoisted.getUser.mockRejectedValueOnce(
      Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { resolveNote } = await loadStats();

    const r = await resolveNote("p1", "resp1", "nota");

    expect(r).toEqual({
      success: false,
      error: copyWithRef("Não foi possível concluir a ação. Tente novamente."),
    });
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[stats] resolução falhou", { code: "ECONNRESET", message: "fetch failed" }),
    );
    consoleError.mockRestore();
  });
});

describe("fetchGabaritoForComment — respostas atuais e erro de leitura", () => {
  it("mostra só respostas atuais do documento e projeto pedidos", async () => {
    const current = { id: "current", project_id: "p1", document_id: "doc1", is_latest: true,
      respondent_name: "Pesquisadora", respondent_type: "humano", answers: { q1: "A" } };
    tableData.responses = [
      current,
      { ...current, id: "old", is_latest: false },
      { ...current, id: "other-project", project_id: "other" },
      { ...current, id: "other-doc", document_id: "other" },
    ];
    const { fetchGabaritoForComment } = await loadStats();

    expect(await fetchGabaritoForComment("p1", "doc1", "q1", "current")).toEqual({
      answers: [{ id: "current", respondentName: "Pesquisadora", respondentType: "humano", answer: "A", isChosen: true }],
    });
  });

  // #622: o nome gravado na resposta congela o que o perfil tinha no dia.
  it("mostra o nome do perfil no lugar do e-mail gravado na resposta", async () => {
    tableData.responses = [
      { id: "r1", project_id: "p1", document_id: "doc1", is_latest: true, respondent_id: "ana",
        respondent_name: "ana@example.com", respondent_type: "humano", answers: { q1: "A" } },
    ];
    tableData.project_members = [
      { project_id: "p1", user_id: "ana", profiles: { first_name: "Ana", last_name: "Lima" } },
    ];
    const { fetchGabaritoForComment } = await loadStats();

    const r = await fetchGabaritoForComment("p1", "doc1", "q1", null);

    expect(r.answers.map((a) => a.respondentName)).toEqual(["Ana Lima"]);
  });

  // Antes, a leitura com erro devolvia o gabarito vazio, como se ninguém
  // tivesse respondido (P3).
  it("devolve a copy pt-BR, e não um gabarito vazio sem aviso", async () => {
    queryErrors["responses:select"] = { message: "timeout", code: "57014" };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchGabaritoForComment } = await loadStats();

    const r = await fetchGabaritoForComment("p1", "doc1", "q1", null);

    expect(r).toEqual({
      answers: [],
      error: copyWithRef("Não foi possível carregar as respostas do gabarito. Tente novamente."),
    });
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[stats] leitura do gabarito falhou", { code: "57014", message: "timeout" }),
    );
    consoleError.mockRestore();
  });
});

describe("resolveNote / reopenNote", () => {
  it("resolveNote: sucesso → insert em note_resolutions e revalida", async () => {
    const { resolveNote } = await loadStats();

    const r = await resolveNote("p1", "resp1", "nota");

    expect(r).toEqual({ success: true });
    expect(writeCalls).toEqual([
      {
        table: "note_resolutions",
        op: "insert",
        payload: {
          project_id: "p1",
          response_id: "resp1",
          resolved_by: "user1",
          note: "nota",
        },
        filters: [],
      },
    ]);
  });

  it("resolveNote: nota omitida → grava note: null", async () => {
    const { resolveNote } = await loadStats();

    await resolveNote("p1", "resp1");

    expect(
      (writeCalls[0].payload as { note: string | null }).note,
    ).toBeNull();
  });

  // O texto do Postgres ia cru, em inglês, ao toast pt-BR: vai ao log do
  // servidor, e a action devolve a copy do fluxo (#502).
  it.each([
    ["resolveNote", "note_resolutions:insert", (m: Stats) => m.resolveNote("p1", "resp1", "nota"),
      "Não foi possível resolver a anotação. Tente novamente."],
    ["reopenNote", "note_resolutions:delete", (m: Stats) => m.reopenNote("p1", "resp1"),
      "Não foi possível reabrir a resolução. Tente novamente."],
    ["resolveReviewComment", "reviews:update", (m: Stats) => m.resolveReviewComment("rev1", "p1"),
      "Não foi possível resolver o comentário. Tente novamente."],
    ["reopenDuvida", "verdict_acknowledgments:update", (m: Stats) => m.reopenDuvida("p1", "rev1", "user2"),
      "Não foi possível atualizar a dúvida. Tente novamente."],
    ["resolveDifficulty", "difficulty_resolutions:insert", (m: Stats) => m.resolveDifficulty("p1", "resp1", "doc1"),
      "Não foi possível resolver a dificuldade. Tente novamente."],
  ])("%s: erro do Supabase → copy pt-BR, texto cru no log, sem revalidar", async (_, operation, run, copy) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    queryErrors[operation] = { code: "57014", message: "canceling statement due to statement timeout" };

    const r = await run(await loadStats());

    expect(r).toEqual({ success: false, error: copyWithRef(copy) });
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine(/\[stats\] .* falhou/, { code: "57014", message: "canceling statement due to statement timeout" }),
    );
    expect(hoisted.revalidate).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("reopenNote: sucesso → delete e retorna success", async () => {
    tableData = {
      note_resolutions: [
        { project_id: "p1", response_id: "resp1" },
        { project_id: "other", response_id: "resp1" },
        { project_id: "p1", response_id: "other" },
      ],
    };
    const { reopenNote } = await loadStats();

    const r = await reopenNote("p1", "resp1");

    expect(r).toEqual({ success: true });
    expect(writeCalls[0]).toMatchObject({
      table: "note_resolutions",
      op: "delete",
      filters: [["eq", "project_id", "p1"], ["eq", "response_id", "resp1"]],
    });
  });

  it("reopenNote: nada afetado → error de not-found (sem permissão ou já reaberta)", async () => {
    tableData = { note_resolutions: [] };
    const { reopenNote } = await loadStats();

    const r = await reopenNote("p1", "resp1");

    expect(r).toEqual({
      success: false,
      error: "Nada reaberto: sem permissão ou anotação já reaberta",
    });
  });
});

describe("resolveReviewComment / reopenReviewComment — smoke", () => {
  const review = {
    id: "rv1", project_id: "p1", document_id: "doc1", field_name: "q1",
    verdict: "concordo", comment: "Comentário",
  };
  it("resolveReviewComment: sucesso", async () => {
    tableData = { reviews: [review, { ...review, id: "other" }] };
    const { resolveReviewComment } = await loadStats();

    const r = await resolveReviewComment("rv1", "p1");

    expect(r).toEqual({ success: true });
    expect(writeCalls[0].filters).toEqual([["eq", "id", "rv1"]]);
  });

  it("reopenReviewComment: sucesso", async () => {
    tableData = { reviews: [review, { ...review, id: "other" }] };
    const { reopenReviewComment } = await loadStats();

    const r = await reopenReviewComment("rv1", "p1");

    expect(r).toEqual({ success: true });
    expect(writeCalls[0].filters).toEqual([["eq", "id", "rv1"]]);
  });
});

describe("resolveDuvida / reopenDuvida — smoke", () => {
  it("resolveDuvida: sucesso", async () => {
    tableData = {
      verdict_acknowledgments: [
        { review_id: "rv1", respondent_id: "user2" },
        { review_id: "other", respondent_id: "user2" },
        { review_id: "rv1", respondent_id: "other" },
      ],
    };
    const { resolveDuvida } = await loadStats();

    const r = await resolveDuvida("p1", "rv1", "user2");

    expect(r).toEqual({ success: true });
    expect(writeCalls[0].filters).toEqual([["eq", "review_id", "rv1"], ["eq", "respondent_id", "user2"]]);
  });

  it("reopenDuvida: sucesso", async () => {
    tableData = {
      verdict_acknowledgments: [
        { review_id: "rv1", respondent_id: "user2" },
        { review_id: "other", respondent_id: "user2" },
        { review_id: "rv1", respondent_id: "other" },
      ],
    };
    const { reopenDuvida } = await loadStats();

    const r = await reopenDuvida("p1", "rv1", "user2");

    expect(r).toEqual({ success: true });
    expect(writeCalls[0].filters).toEqual([["eq", "review_id", "rv1"], ["eq", "respondent_id", "user2"]]);
  });
});

describe("resolveDifficulty / reopenDifficulty — smoke", () => {
  it("resolveDifficulty: sucesso", async () => {
    const { resolveDifficulty } = await loadStats();

    const r = await resolveDifficulty("p1", "resp1", "doc1", "nota");

    expect(r).toEqual({ success: true });
  });

  it("reopenDifficulty: sucesso", async () => {
    tableData = {
      difficulty_resolutions: [
        { project_id: "p1", response_id: "resp1" },
        { project_id: "other", response_id: "resp1" },
        { project_id: "p1", response_id: "other" },
      ],
    };
    const { reopenDifficulty } = await loadStats();

    const r = await reopenDifficulty("p1", "resp1");

    expect(r).toEqual({ success: true });
    expect(writeCalls[0].filters).toEqual([["eq", "project_id", "p1"], ["eq", "response_id", "resp1"]]);
  });
});

describe("resolveError / reopenError", () => {
  const row = resolutionFixture();
  const input = { decision: "llm_correct" as const, context: row.context!, expected: null, note: "Conferido" };

  it("salva contexto e escolha pela RPC, sem gravar diretamente a tabela", async () => {
    hoisted.rpc.mockResolvedValue({ data: row, error: null });
    const { resolveError } = await loadStats();
    expect(await resolveError("p1", "doc1", "x", input)).toEqual({ success: true });
    expect(hoisted.rpc).toHaveBeenCalledWith("set_error_resolution", {
      p_project_id: "p1", p_document_id: "doc1", p_field_name: "x",
      p_decision: "llm_correct", p_expected_context: row.context,
      p_expected_id: null, p_expected_resolved_at: null, p_note: "Conferido", p_value: null,
    });
    expect(writeCalls).toHaveLength(0);
    expect(hoisted.revalidate).toHaveBeenCalledWith("/projects/p1/reviews/gabarito");
  });

  it("Erro do LLM envia o valor escolhido para a RPC validar (#733)", async () => {
    hoisted.rpc.mockResolvedValue({ data: row, error: null });
    const { resolveError } = await loadStats();
    expect(await resolveError("p1", "doc1", "x", { ...input, decision: "researchers_correct", value: ["A", "B"] })).toEqual({ success: true });
    expect(hoisted.rpc).toHaveBeenCalledWith("set_error_resolution", expect.objectContaining({
      p_decision: "researchers_correct", p_value: ["A", "B"],
    }));
  });

  it("Todos errados envia o valor escolhido", async () => {
    hoisted.rpc.mockResolvedValue({ data: row, error: null });
    const { resolveError } = await loadStats();
    await resolveError("p1", "doc1", "x", { ...input, decision: "all_wrong", value: "Terceira" });
    expect(hoisted.rpc).toHaveBeenLastCalledWith("set_error_resolution", expect.objectContaining({ p_decision: "all_wrong", p_value: "Terceira" }));
  });

  // #758: "Ambos corretos" leva o valor comum que a fila calculou, inclusive
  // o branco "", e o RPC o confere contra o contexto.
  it.each<[string, string | undefined, string | null]>([
    ["o valor comum", "LLM", "LLM"],
    ["o branco comum de condicional", "", ""],
    ["nulo quando não há valor comum", undefined, null],
  ])("Ambos corretos envia %s", async (_label, value, expected) => {
    hoisted.rpc.mockResolvedValue({ data: row, error: null });
    const { resolveError } = await loadStats();
    await resolveError("p1", "doc1", "x", { ...input, decision: "both_correct", ...(value === undefined ? {} : { value }) });
    expect(hoisted.rpc).toHaveBeenLastCalledWith("set_error_resolution", expect.objectContaining({ p_decision: "both_correct", p_value: expected }));
  });

  it("valor só acompanha Erro do LLM: Erro humano manda p_value nulo mesmo que venha", async () => {
    hoisted.rpc.mockResolvedValue({ data: row, error: null });
    const { resolveError } = await loadStats();
    await resolveError("p1", "doc1", "x", { ...input, value: "ignorado" });
    expect(hoisted.rpc).toHaveBeenCalledWith("set_error_resolution", expect.objectContaining({ p_decision: "llm_correct", p_value: null }));
  });

  it.each(["Sem permissão", "As respostas mudaram", "A decisão mudou"])("não anuncia sucesso para %s", async (message) => {
    hoisted.rpc.mockResolvedValue({ data: null, error: { message } });
    const { resolveError } = await loadStats();
    expect(await resolveError("p1", "doc1", "x", input)).toEqual({ success: false, error: message });
    expect(hoisted.revalidate).not.toHaveBeenCalled();
  });

  it.each([null, { ...input, decision: "invalid" }, { ...input, context: null }])("recusa entrada inválida antes da RPC: %j", async (invalid) => {
    const { resolveError } = await loadStats();
    expect(await resolveError("p1", "doc1", "x", invalid as unknown as typeof input)).toEqual({ success: false, error: "Decisão ou contexto inválido." });
    expect(hoisted.rpc).not.toHaveBeenCalled();
  });

  it("sem confirmação do banco não assume que salvou", async () => {
    hoisted.rpc.mockResolvedValue({ data: null, error: null });
    const { resolveError } = await loadStats();
    expect((await resolveError("p1", "doc1", "x", input)).success).toBe(false);
  });

  it("reabertura exige a identidade e a data que a pessoa examinou", async () => {
    hoisted.rpc.mockResolvedValue({ data: { reopened: true }, error: null });
    const { reopenError } = await loadStats();
    expect(await reopenError("p1", "doc1", "x", row)).toEqual({ success: true });
    expect(hoisted.rpc).toHaveBeenCalledWith("set_error_resolution", expect.objectContaining({
      p_decision: null, p_expected_id: row.id, p_expected_resolved_at: row.resolved_at,
    }));
    expect(writeCalls).toHaveLength(0);
  });

  const prepareInput = { projectId: "p1", documentId: "doc1", fieldName: "x", llmResponseId: "rllm", preferredHumanResponseId: "rh", sourceKind: "comparacao" as const, sourceId: "review1", decision: "llm_correct" as const };
  function humansInRound(ids: string[], currentRoundId: string | null = "round1") {
    resetFixtures({
      projects: [
        { id: "p1", current_round_id: currentRoundId },
        { id: "other", current_round_id: "other-round" },
      ],
      responses: [
        ...ids.map((id) => ({
          id, project_id: "p1", document_id: "doc1", respondent_type: "humano",
          is_latest: true, round_id: currentRoundId,
        })),
        { id: "other-project", project_id: "other", document_id: "doc1", respondent_type: "humano", is_latest: true, round_id: currentRoundId },
        { id: "other-doc", project_id: "p1", document_id: "other", respondent_type: "humano", is_latest: true, round_id: currentRoundId },
        { id: "old", project_id: "p1", document_id: "doc1", respondent_type: "humano", is_latest: false, round_id: currentRoundId },
        { id: "llm", project_id: "p1", document_id: "doc1", respondent_type: "llm", is_latest: true, round_id: currentRoundId },
        { id: "other-round", project_id: "p1", document_id: "doc1", respondent_type: "humano", is_latest: true, round_id: "other-round" },
      ],
    });
  }

  it("preparar a confirmação lê contexto sem gravar decisão", async () => {
    humansInRound(["rh2", "rh"]);
    hoisted.rpc.mockResolvedValue({ data: row.context, error: null });
    const { prepareErrorResolution } = await loadStats();
    expect(await prepareErrorResolution(prepareInput)).toEqual({ context: row.context });
    expect(hoisted.rpc).toHaveBeenCalledTimes(1);
    // A resposta que a arbitragem escolheu vence quando ainda é humana corrente.
    expect(hoisted.rpc).toHaveBeenCalledWith("llm_error_context", expect.objectContaining({ p_human_response_id: "rh" }));
    expect(writeCalls).toHaveLength(0);
  });

  it("sem a escolhida na rodada corrente, ancora na humana mais antiga da rodada (#733)", async () => {
    humansInRound(["rh2", "rh3"]);
    hoisted.rpc.mockResolvedValue({ data: row.context, error: null });
    const { prepareErrorResolution } = await loadStats();
    await prepareErrorResolution(prepareInput);
    expect(hoisted.rpc).toHaveBeenCalledWith("llm_error_context", expect.objectContaining({ p_human_response_id: "rh2" }));
  });

  // Sobre veredito que perdeu a validade, só as decisões que dependem dele
  // ("Ambos corretos", "Em discussão") pedem fonte válida; as que gravam valor
  // próprio podem ser redecididas entre si.
  it.each<[ErrorDecision, boolean]>([
    ["llm_correct", false],
    ["researchers_correct", false],
    ["all_wrong", false],
    ["both_correct", true],
    ["discussion", true],
  ])("%s pede o contexto com p_require_valid_source = %s", async (decision, required) => {
    humansInRound(["rh"]);
    hoisted.rpc.mockResolvedValue({ data: row.context, error: null });
    const { prepareErrorResolution } = await loadStats();
    await prepareErrorResolution({ ...prepareInput, decision });
    expect(hoisted.rpc).toHaveBeenCalledWith("llm_error_context", expect.objectContaining({ p_require_valid_source: required }));
  });

  // #758: com o valor comum que a fila calculou, "Ambos corretos" grava valor
  // próprio e deixa de pedir a fonte, como `set_error_resolution` ao gravar.
  // O branco comum ("" ou []) também é valor.
  it.each([["A"], [""], [[]]])("Ambos corretos com o valor comum %j não pede a fonte", async (value) => {
    humansInRound(["rh"]);
    hoisted.rpc.mockResolvedValue({ data: row.context, error: null });
    const { prepareErrorResolution } = await loadStats();
    await prepareErrorResolution({ ...prepareInput, decision: "both_correct", bothCorrectValue: { value } });
    expect(hoisted.rpc).toHaveBeenCalledWith("llm_error_context", expect.objectContaining({ p_require_valid_source: false }));
  });

  it("o valor comum só dispensa a fonte em Ambos corretos", async () => {
    humansInRound(["rh"]);
    hoisted.rpc.mockResolvedValue({ data: row.context, error: null });
    const { prepareErrorResolution } = await loadStats();
    await prepareErrorResolution({ ...prepareInput, decision: "discussion", bothCorrectValue: { value: "A" } });
    expect(hoisted.rpc).toHaveBeenCalledWith("llm_error_context", expect.objectContaining({ p_require_valid_source: true }));
  });

  it("auto-revisão não troca de humana: sem a do field_reviews na rodada, explica e não chama a RPC", async () => {
    humansInRound(["rh2", "rh3"]);
    const { prepareErrorResolution } = await loadStats();
    const result = await prepareErrorResolution({ ...prepareInput, sourceKind: "auto_revisao" as const, sourceId: "fr" });
    expect(result.context).toBeUndefined();
    expect(result.error).toContain("auto-revisão não está mais ativa");
    expect(hoisted.rpc).not.toHaveBeenCalled();
  });

  it("auto-revisão com a humana do field_reviews ainda corrente segue normalmente", async () => {
    humansInRound(["rh2", "rh"]);
    hoisted.rpc.mockResolvedValue({ data: row.context, error: null });
    const { prepareErrorResolution } = await loadStats();
    await prepareErrorResolution({ ...prepareInput, sourceKind: "auto_revisao" as const, sourceId: "fr" });
    expect(hoisted.rpc).toHaveBeenCalledWith("llm_error_context", expect.objectContaining({ p_human_response_id: "rh" }));
  });

  it.each<[string, () => void, "comparacao" | "auto_revisao", string]>([
    ["sem humana na rodada", () => humansInRound([]), "comparacao", "Nenhuma resposta humana ativa"],
    // Sem rodada não adianta refazer revisão nenhuma: a mensagem aponta a causa.
    ["sem rodada corrente", () => humansInRound(["rh"], null), "comparacao", "sem rodada corrente"],
    ["auto-revisão sem rodada corrente", () => humansInRound(["rh"], null), "auto_revisao", "sem rodada corrente"],
  ])("%s explica o bloqueio sem chamar a RPC", async (_name, arrange, sourceKind, message) => {
    arrange();
    const { prepareErrorResolution } = await loadStats();
    const result = await prepareErrorResolution({ ...prepareInput, sourceKind });
    expect(result.context).toBeUndefined();
    expect(result.error).toContain(message);
    expect(hoisted.rpc).not.toHaveBeenCalled();
  });
});
