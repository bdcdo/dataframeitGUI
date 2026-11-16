import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";

// Testa a server action getExportDataset: gate coordinator-only fail-closed,
// queries paralelas com colunas explícitas, e delegação da montagem a
// lib/export/assemble (o shape do contrato).
import { makeFilterAwareSupabaseMock, type ReadCall, type WriteCall } from "@/test-utils/supabase-mock";

type Fixture = Pick<Parameters<typeof makeFilterAwareSupabaseMock>[0], "tableData" | "queryErrors" | "queryErrorForCall" | "afterRead" | "readCalls" | "rpcResults">;
let writeCalls: WriteCall[];
let readCalls: ReadCall[];
let server: Fixture;

const hoisted = vi.hoisted(() => ({
  requireCoordinator: vi.fn<
    (
      projectId: string,
      deniedMessage: string
    ) => Promise<{ ok: true; user: { id: string } } | { ok: false; error: string }>
  >(async () => ({ ok: true, user: { id: "userCoord" } })),
}));

vi.mock("@/lib/auth", () => ({
  requireCoordinator: (projectId: string, deniedMessage: string) =>
    hoisted.requireCoordinator(projectId, deniedMessage),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    // Só as colunas do select, como o PostgREST: uma coluna esquecida nele
    // passaria sem aviso com a linha inteira.
    makeFilterAwareSupabaseMock({ ...server, writeCalls, readCalls, projectColumns: true }),
}));

beforeEach(() => {
  writeCalls = [];
  readCalls = [];
  server = { tableData: {}, readCalls };
  hoisted.requireCoordinator.mockResolvedValue({
    ok: true,
    user: { id: "userCoord" },
  });
});

async function loadAction() {
  return (await import("@/actions/export")).getExportDataset;
}

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/export");
}, 30_000);

describe("getExportDataset — gate coordinator-only", () => {
  it("retorna {error} fail-closed para não-coordenador (não consulta dados)", async () => {
    hoisted.requireCoordinator.mockResolvedValue({
      ok: false,
      error: "Apenas coordenadores podem exportar os dados do projeto.",
    });
    const getExportDataset = await loadAction();

    const r = await getExportDataset("proj-1");

    expect(r).toEqual({
      error: "Apenas coordenadores podem exportar os dados do projeto.",
    });
  });
});

// As linhas declaram as colunas que as queries filtram. `withOthers` junta a
// cada tabela as linhas que o filtro precisa descartar: as de outro projeto,
// o documento excluído e a versão antiga da resposta, todas no documento d1,
// onde mudariam o resultado se passassem.
const doc = (id: string, extra: Record<string, unknown> = {}) => ({
  id, external_id: null, title: null, created_at: "2024-01-01", metadata: null,
  project_id: "proj-1", excluded_at: null, ...extra,
});
const projectRow = (extra: Record<string, unknown> = {}) => ({
  id: "proj-1", name: "P", pydantic_fields: [], min_responses_for_comparison: 2,
  automation_mode: null, current_round_id: null, ...extra,
});
const response = (id: string, type: string, value: string, extra: Record<string, unknown> = {}) => ({
  id, document_id: "d1", respondent_name: id, respondent_type: type, is_partial: false, answers: { campo: value },
  project_id: "proj-1", is_latest: true, ...extra,
});
const withOthers = (tables: Record<string, unknown[]>): Record<string, unknown[]> => {
  const other = { project_id: "proj-2" };
  const add = (table: string, rows: unknown[]) => [...(tables[table] ?? []), ...rows];
  return {
    ...tables,
    projects: add("projects", [projectRow({ id: "proj-2", name: "Outro" })]),
    documents: add("documents", [doc("x-excluido", { external_id: "EXT-X", excluded_at: "2026-01-01" }), doc("x-alheio", other)]),
    responses: add("responses", [
      response("x-antiga", "humano", "Antiga", { is_latest: false }),
      response("x-alheia", "humano", "Alheia", other),
    ]),
    // Veredito de outro projeto no campo de d1: se passasse, viraria a célula
    // do Gabarito.
    reviews: add("reviews", [
      { id: "x-review", document_id: "d1", field_name: "campo", verdict: "Alheio", comment: null,
        created_at: "2024-01-01", field_hash: "campo-hash", chosen_response_id: null, reviewer_id: "u9",
        project_id: "proj-2" },
    ]),
  };
};

describe("getExportDataset — monta o dataset a partir das queries", () => {
  // #622: `respondent_name` congela o que o perfil tinha no dia da gravação,
  // e a mesma pessoa saía na exportação sob dois nomes.
  it("a mesma pessoa gravada sob dois nomes sai com o nome do perfil", async () => {
    server = {
      tableData: withOthers({
        projects: [projectRow({ pydantic_fields: [{ name: "campo", type: "text", options: null, description: "" }] })],
        documents: [doc("d1"), doc("d2")],
        responses: [
          response("r1", "humano", "A", { respondent_id: "ana", respondent_name: "ana@example.com" }),
          response("r2", "humano", "B", { document_id: "d2", respondent_id: "ana", respondent_name: "Ana Lima" }),
        ],
        project_members: [
          { project_id: "proj-1", user_id: "ana", profiles: { first_name: "Ana", last_name: "Lima" } },
        ],
      }),
    };

    const getExportDataset = await loadAction();
    const r = await getExportDataset("proj-1");

    if ("error" in r) throw new Error(`esperava dataset, veio erro: ${r.error}`);
    const respondentOf = (sheet: { headers: string[]; rows: unknown[][] }) =>
      sheet.rows.map((row) => row[sheet.headers.indexOf("respondent")]);
    expect(respondentOf(r.responses)).toEqual(["Ana Lima", "Ana Lima"]);
    expect(respondentOf(r.csv)).toEqual(["Ana Lima", "Ana Lima"]);
  });

  it("retorna o shape do contrato com colunas originais e linhas por origem", async () => {
    server = {
      tableData: withOthers({
        projects: [
          projectRow({
            name: "Meu Projeto",
            pydantic_fields: [{ name: "campo", type: "text", options: null, description: "" }],
          }),
        ],
        documents: [
          doc("d1", {
            external_id: "EXT-1",
            title: "Doc 1",
            metadata: { original_columns: ["tribunal"], original_row: { tribunal: "TJSP" } },
          }),
          doc("d2", { created_at: "2024-01-02" }),
        ],
        responses: [
          { document_id: "d1", respondent_name: "R1", respondent_type: "llm", answers: { campo: "valor" },
            project_id: "proj-1", is_latest: true },
        ],
      }),
    };

    const getExportDataset = await loadAction();
    const r = await getExportDataset("proj-1");

    if ("error" in r) throw new Error(`esperava dataset, veio erro: ${r.error}`);
    expect(r.projectName).toBe("Meu Projeto");
    // Coluna original 'tribunal' presente na aba Documentos.
    expect(r.documents.headers).toContain("tribunal");
    // d1 tem resposta (linha 'llm'); d2 é órfão (linha 'documento').
    const sourceIdx = r.csv.headers.indexOf("source");
    const sources = r.csv.rows.map((row) => row[sourceIdx]);
    expect(sources).toContain("llm");
    expect(sources).toContain("documento");
    // Só os dois documentos ativos do projeto, e só a resposta vigente dele.
    expect(r.documents.rows).toHaveLength(2);
    expect(r.csv.rows.flat()).not.toContain("Antiga");
    expect(r.csv.rows.flat()).not.toContain("Alheia");
    // Leitura só: nenhuma escrita.
    expect(writeCalls).toEqual([]);
  });

  it("pagina as queries: busca todas as páginas quando a primeira vem cheia", async () => {
    // 1001 documentos: a 1ª página cheia (1000) força uma 2ª busca (.range).
    server = {
      tableData: withOthers({
        projects: [projectRow()],
        documents: Array.from({ length: 1001 }, (_, i) => doc(`d${i}`, { external_id: `EXT-${i}` })),
      }),
    };

    const getExportDataset = await loadAction();
    const r = await getExportDataset("proj-1");

    if ("error" in r) throw new Error(`esperava dataset, veio erro: ${r.error}`);
    // 1000 + 1 = todas as linhas, sem truncar no max_rows.
    expect(r.documents.rows).toHaveLength(1001);
  });

  it.each(["remove", "insere"] as const)("cursor de documents resiste quando uma escrita %s antes da página seguinte", async (change) => {
    const documents = Array.from({ length: 1001 }, (_, i) => doc(`d${String(i).padStart(4, "0")}`, { external_id: `EXT-${i}` }));
    let reads = 0;
    server = {
      tableData: withOthers({ projects: [projectRow()], documents }),
      afterRead: (source) => {
        if (source !== "documents" || ++reads !== 1) return;
        if (change === "remove") server.tableData.documents.shift();
        else server.tableData.documents.unshift(doc("d0000a", { external_id: "NOVA" }));
      },
    };
    const getExportDataset = await loadAction();
    const r = await getExportDataset("proj-1");
    if ("error" in r) throw new Error(r.error);

    expect(r.documents.rows).toHaveLength(1001);
    const exportedIds = r.documents.rows.map((row) => row[0]);
    expect(exportedIds).toContain("EXT-1000");
    expect(exportedIds).not.toContain("NOVA");
    expect(new Set(exportedIds).size).toBe(1001);
    expect(reads).toBe(2);
  });

  it("falha na segunda página de documents sem devolver exportação parcial", async () => {
    let reads = 0;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    server = {
      tableData: withOthers({
        projects: [projectRow()],
        documents: Array.from({ length: 1001 }, (_, i) => doc(`d${String(i).padStart(4, "0")}`)),
      }),
      queryErrorForCall: ({ table }) => table === "documents" && ++reads === 2
        ? { message: "segunda página falhou" } : undefined,
    };
    const getExportDataset = await loadAction();
    expect(await getExportDataset("proj-1")).toEqual({ error: copyWithRef("Não foi possível carregar os dados da exportação. Tente novamente.") });
    expect(reads).toBe(2);
    consoleError.mockRestore();
  });

  it("pagina a RPC de resoluções e a view pela chave composta", async () => {
    const resolutions = Array.from({ length: 1001 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}` }));
    const finalAnswers = Array.from({ length: 1001 }, (_, i) => ({
      project_id: "proj-1", document_id: "d1", field_name: `f${String(i).padStart(4, "0")}`,
      provenance: "consenso", answer: null,
    }));
    server = {
      tableData: withOthers({ projects: [projectRow({ automation_mode: "auto_review_llm" })], final_answers: finalAnswers }),
      // A RPC retorna as mesmas linhas em cada chamada; o cursor restringe a segunda.
      rpcResults: { read_error_resolutions: { data: resolutions } },
    };
    const getExportDataset = await loadAction();
    const r = await getExportDataset("proj-1");
    if ("error" in r) throw new Error(r.error);
    expect(readCalls.filter((call) => call.table === "final_answers")).toHaveLength(2);
    expect(readCalls.filter((call) => call.table === "final_answers")[1].filters).toEqual([
      ["eq", "project_id", "proj-1"],
      ["or", "", 'document_id.gt."d1",and(document_id.eq."d1",field_name.gt."f0999")'],
    ]);
  });

  it("erro na segunda página da RPC impede exportação parcial", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    server = {
      tableData: withOthers({ projects: [projectRow()] }),
      rpcResults: {
        read_error_resolutions: [
          { data: Array.from({ length: 1000 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}` })) },
          { error: { message: "RPC interrompida" } },
        ],
      },
    };
    const getExportDataset = await loadAction();
    expect(await getExportDataset("proj-1")).toEqual({ error: copyWithRef("Não foi possível carregar os dados da exportação. Tente novamente.") });
    consoleError.mockRestore();
  });

  // O texto do Postgres ia cru, em inglês, ao toast pt-BR: vai ao log do
  // servidor, e a action devolve a copy do fluxo (#502).
  it("erro de uma query vira copy pt-BR, e o texto cru vai ao log", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    server = {
      tableData: withOthers({ projects: [projectRow()] }),
      queryErrors: { "documents:select": { message: "boom na query de documentos" } },
    };
    const getExportDataset = await loadAction();
    const r = await getExportDataset("proj-1");
    expect(r).toEqual({ error: copyWithRef("Não foi possível carregar os dados da exportação. Tente novamente.") });
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[export] leitura falhou", { message: "boom na query de documentos" }),
    );
    consoleError.mockRestore();
  });
});

// A ligação com o banco das duas fontes de julgamento que o export lê além das
// respostas: os pares "=" da Comparação e a view `final_answers` da
// auto-revisão. Um erro ignorado ou uma coluna faltando não quebra nada à
// vista; só deixa células do Gabarito em branco.
describe("getExportDataset: equivalências \"=\" e auto-revisão", () => {
  const campo = [{ name: "campo", type: "text", options: null, description: "", hash: "campo-hash" }];
  const base = (automationMode: string | null, responses: unknown[]): Fixture => ({
    tableData: withOthers({
      projects: [projectRow({ pydantic_fields: campo, automation_mode: automationMode })],
      documents: [doc("d1", { external_id: "EXT-1" })],
      responses,
    }),
  });
  const gabaritoCell = (r: Awaited<ReturnType<Awaited<ReturnType<typeof loadAction>>>>) => {
    if ("error" in r) throw new Error(`esperava dataset, veio erro: ${r.error}`);
    return r.verdicts.rows.find((row) => row[0] === "EXT-1")?.[r.verdicts.headers.indexOf("campo")] ?? "";
  };
  const equivalence = (id: string, value_a: string, value_b: string, project_id = "proj-1") => ({
    id, project_id, field_name: "campo", field_hash: "campo-hash", value_a, value_b, reviewer_id: null,
  });

  it("a equivalência de valor chega com o hash do campo e funde as respostas dos pesquisadores", async () => {
    server = base(null, [response("h1", "humano", "NI"), response("h2", "humano", "Não informado"), response("l", "llm", "Sim")]);
    server.tableData.value_equivalences = [equivalence("eq1", "NI", "Não informado")];
    const r = await (await loadAction())("proj-1");
    expect(["NI", "Não informado"]).toContain(gabaritoCell(r));
  });

  it("a equivalência de outro projeto não funde", async () => {
    server = base(null, [response("h1", "humano", "NI"), response("h2", "humano", "Não informado"), response("l", "llm", "Sim")]);
    server.tableData.value_equivalences = [equivalence("eq9", "NI", "Não informado", "proj-2")];
    expect(gabaritoCell(await (await loadAction())("proj-1"))).toBe("");
  });

  it("propaga o erro da leitura das equivalências", async () => {
    server = { ...base(null, []), queryErrors: { "value_equivalences:select": { message: "boom nos pares" } } };
    const r = await (await loadAction())("proj-1");
    expect(r).toEqual({ error: copyWithRef("Não foi possível carregar os dados da exportação. Tente novamente.") });
  });

  it("em projeto de auto-revisão, a célula resolvida pela view entra no Gabarito", async () => {
    server = base("auto_review_llm", [response("h1", "humano", "Sim"), response("l", "llm", "Não")]);
    server.tableData.final_answers = [
      { document_id: "d1", field_name: "campo", provenance: "arbitrado", answer: "Não", project_id: "proj-1" },
      // A de outro projeto vem depois: se passasse, sobrescreveria a célula.
      { document_id: "d1", field_name: "campo", provenance: "arbitrado", answer: "Sim", project_id: "proj-2" },
    ];
    const r = await (await loadAction())("proj-1");
    expect(gabaritoCell(r)).toBe("Não");
  });

  it("a opção de preencher com o LLM chega à montagem, e só o true a liga", async () => {
    const soLlm = () => base(null, [response("l", "llm", "Sim")]);
    server = soLlm();
    expect(gabaritoCell(await (await loadAction())("proj-1"))).toBe("");
    server = soLlm();
    const loose = { fillFromLlm: "sim" } as unknown as { fillFromLlm: boolean };
    expect(gabaritoCell(await (await loadAction())("proj-1", loose))).toBe("");
    server = soLlm();
    const r = await (await loadAction())("proj-1", { fillFromLlm: true });
    expect(gabaritoCell(r)).toBe("Sim");
    if ("error" in r) throw new Error(r.error);
    expect(r.llmOnly.rows).toEqual([["EXT-1", "", "campo"]]);
  });

  it("a opção de incluir rascunhos chega à montagem, e só o true a liga", async () => {
    // O rascunho completa o consenso só com a opção. O select precisa trazer
    // `is_partial`: sem a coluna, a resposta entregue também contaria como
    // rascunho, e a célula sairia em branco nos três casos.
    const comRascunho = () => base(null, [response("h1", "humano", "Sim"), response("h2", "humano", "Sim", { is_partial: true })]);
    server = comRascunho();
    const padrao = await (await loadAction())("proj-1");
    expect(gabaritoCell(padrao)).toBe("");
    if ("error" in padrao) throw new Error(padrao.error);
    expect(padrao.responses.rows.map((row) => row.at(-1))).toEqual(["não", "sim"]);
    server = comRascunho();
    const loose = { includeDrafts: "sim" } as unknown as { includeDrafts: boolean };
    expect(gabaritoCell(await (await loadAction())("proj-1", loose))).toBe("");
    server = comRascunho();
    expect(gabaritoCell(await (await loadAction())("proj-1", { includeDrafts: true }))).toBe("Sim");
  });

  it("propaga o erro da leitura de final_answers", async () => {
    server = { ...base("auto_review_llm", []), queryErrors: { "final_answers:select": { message: "boom na view" } } };
    const r = await (await loadAction())("proj-1");
    expect(r).toEqual({ error: copyWithRef("Não foi possível carregar os dados da exportação. Tente novamente.") });
  });
});

// As atribuições de comparação decidem o motivo da divergência nas Pendências:
// só as da rodada atual contam, e o projeto sem rodada atual não as usa.
describe("getExportDataset: atribuições de comparação da rodada atual", () => {
  const campo = [{ name: "campo", type: "text", options: null, description: "" }];
  const assignment = (round_id: string, extra: Record<string, unknown> = {}) => ({
    document_id: "d1", round_id, project_id: "proj-1", type: "comparacao", ...extra,
  });
  // Atribuições na rodada r2 que os filtros precisam descartar: a de
  // codificação e a de outro projeto.
  const filteredOut = [assignment("r2", { type: "codificacao" }), assignment("r2", { project_id: "proj-2" })];
  const tables = (currentRound: string | null, assignments: unknown[]): Fixture => ({
    tableData: withOthers({
      projects: [projectRow({ pydantic_fields: campo, current_round_id: currentRound })],
      documents: [doc("d1", { external_id: "EXT-1" })],
      responses: [response("h1", "humano", "Sim"), response("l", "llm", "Não")],
      assignments: [...assignments, ...filteredOut],
    }),
  });
  const reasonOf = async (fixture: Fixture) => {
    server = fixture;
    const r = await (await loadAction())("proj-1");
    if ("error" in r) throw new Error(r.error);
    return r.pending.rows.map((row) => row[3]);
  };

  it("atribuição na rodada atual: aguarda arbitragem", async () => {
    expect(await reasonOf(tables("r2", [assignment("r2")]))).toEqual(["aguarda arbitragem"]);
  });

  it("atribuição só em rodada anterior: divergência sem comparação atribuída", async () => {
    expect(await reasonOf(tables("r2", [assignment("r1")]))).toEqual(["divergência sem comparação atribuída"]);
  });

  it("projeto sem rodada atual: aguarda arbitragem", async () => {
    expect(await reasonOf(tables(null, []))).toEqual(["aguarda arbitragem"]);
  });

  it("propaga o erro da leitura das atribuições", async () => {
    server = { ...tables("r2", []), queryErrors: { "assignments:select": { message: "boom nas atribuições" } } };
    expect(await (await loadAction())("proj-1")).toEqual({ error: copyWithRef("Não foi possível carregar os dados da exportação. Tente novamente.") });
  });
});
