import { describe, it, expect, beforeEach, vi } from "vitest";

// Testa a server action getExportDataset: gate coordinator-only fail-closed,
// queries paralelas com colunas explícitas, e delegação da montagem a
// lib/export/assemble (o shape do contrato). Reusa o makeSupabaseMock.
import {
  makeSupabaseMock,
  type TableResults,
  type WriteCall,
  type RpcCall,
} from "./supabase-mock";

let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let serverTableResults: TableResults | undefined;

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
    projectSelectedColumns(
      makeSupabaseMock({
        tableResults: serverTableResults,
        writeCalls,
        rpcCalls,
      }),
    ),
}));

// O PostgREST devolve só as colunas nomeadas no select, e o mock devolveria a
// linha inteira: uma coluna esquecida no select passaria sem aviso. A projeção
// reproduz o corte sobre o resultado fixado para cada tabela.
function projectSelectedColumns(client: ReturnType<typeof makeSupabaseMock>) {
  const from = client.from;
  client.from = (table: string) => {
    const builder = from(table);
    const select = builder.select as () => unknown;
    const then = builder.then as (resolve: (v: { data: unknown }) => unknown) => unknown;
    let columns: string[] | null = null;
    builder.select = (list: string) => {
      columns = list.split(",").map((c) => c.trim());
      return select();
    };
    const pick = (row: unknown) =>
      columns && row && typeof row === "object"
        ? Object.fromEntries(Object.entries(row).filter(([key]) => columns!.includes(key)))
        : row;
    builder.then = (resolve: (v: unknown) => unknown) =>
      then((result) =>
        resolve({ ...result, data: Array.isArray(result.data) ? result.data.map(pick) : pick(result.data) }),
      );
    return builder;
  };
  return client;
}

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  serverTableResults = undefined;
  hoisted.requireCoordinator.mockResolvedValue({
    ok: true,
    user: { id: "userCoord" },
  });
});

async function loadAction() {
  return (await import("@/actions/export")).getExportDataset;
}

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

describe("getExportDataset — monta o dataset a partir das queries", () => {
  it("retorna o shape do contrato com colunas originais e linhas por origem", async () => {
    serverTableResults = {
      projects: [
        {
          data: {
            name: "Meu Projeto",
            pydantic_fields: [
              { name: "campo", type: "text", options: null, description: "" },
            ],
            min_responses_for_comparison: 2,
          },
        },
      ],
      documents: [
        {
          data: [
            {
              id: "d1",
              external_id: "EXT-1",
              title: "Doc 1",
              created_at: "2024-01-01",
              metadata: {
                original_columns: ["tribunal"],
                original_row: { tribunal: "TJSP" },
              },
            },
            {
              id: "d2",
              external_id: null,
              title: null,
              created_at: "2024-01-02",
              metadata: null,
            },
          ],
        },
      ],
      responses: [
        {
          data: [
            {
              document_id: "d1",
              respondent_name: "R1",
              respondent_type: "llm",
              answers: { campo: "valor" },
            },
          ],
        },
      ],
      reviews: [{ data: [] }],
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
  });

  it("pagina as queries: busca todas as páginas quando a primeira vem cheia", async () => {
    // 1ª página cheia (1000 documentos) força uma 2ª busca (.range) com o resto.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      id: `d${i}`,
      external_id: `EXT-${i}`,
      title: null,
      created_at: "2024-01-01",
      metadata: null,
    }));
    const overflow = [
      {
        id: "d1000",
        external_id: "EXT-1000",
        title: null,
        created_at: "2024-01-02",
        metadata: null,
      },
    ];
    serverTableResults = {
      projects: [
        { data: { name: "P", pydantic_fields: [], min_responses_for_comparison: 2 } },
      ],
      // Fila de duas páginas: só busca a 2ª porque a 1ª veio com 1000 (== page size).
      documents: [{ data: fullPage }, { data: overflow }],
      responses: [{ data: [] }],
      reviews: [{ data: [] }],
    };

    const getExportDataset = await loadAction();
    const r = await getExportDataset("proj-1");

    if ("error" in r) throw new Error(`esperava dataset, veio erro: ${r.error}`);
    // 1000 + 1 = todas as linhas, sem truncar no max_rows.
    expect(r.documents.rows).toHaveLength(1001);
  });

  it("propaga a mensagem de erro de uma query com falha", async () => {
    serverTableResults = {
      projects: [{ data: { name: "P", pydantic_fields: [], min_responses_for_comparison: 2 } }],
      documents: [{ error: { message: "boom na query de documentos" } }],
      responses: [{ data: [] }],
      reviews: [{ data: [] }],
    };
    const getExportDataset = await loadAction();
    const r = await getExportDataset("proj-1");
    expect(r).toEqual({ error: "boom na query de documentos" });
  });
});

// A ligação com o banco das duas fontes de julgamento que o export lê além das
// respostas: os pares "=" da Comparação e a view `final_answers` da
// auto-revisão. Um erro ignorado ou uma coluna faltando não quebra nada à
// vista; só deixa células do Gabarito em branco.
describe("getExportDataset: pares \"=\" e auto-revisão", () => {
  const campo = [{ name: "campo", type: "text", options: null, description: "" }];
  const resposta = (id: string, type: string, value: string) => ({
    id, document_id: "d1", respondent_name: id, respondent_type: type, answers: { campo: value },
  });
  const base = (automationMode: string | null, responses: unknown[]): TableResults => ({
    projects: [{ data: { name: "P", pydantic_fields: campo, min_responses_for_comparison: 2, automation_mode: automationMode } }],
    documents: [{ data: [{ id: "d1", external_id: "EXT-1", title: null, created_at: "2024-01-01", metadata: null }] }],
    responses: [{ data: responses }],
    reviews: [{ data: [] }],
  });
  const gabaritoCell = (r: Awaited<ReturnType<Awaited<ReturnType<typeof loadAction>>>>) => {
    if ("error" in r) throw new Error(`esperava dataset, veio erro: ${r.error}`);
    return r.verdicts.rows.find((row) => row[0] === "EXT-1")?.[r.verdicts.headers.indexOf("campo")] ?? "";
  };

  it("o par \"=\" chega com os snapshots e funde as respostas dos pesquisadores", async () => {
    serverTableResults = {
      ...base(null, [resposta("h1", "humano", "NI"), resposta("h2", "humano", "Não informado"), resposta("l", "llm", "Sim")]),
      response_equivalences: [{
        data: [{
          id: "eq1", document_id: "d1", field_name: "campo", response_a_id: "h1", response_b_id: "h2", reviewer_id: null,
          response_a_answer_snapshot: "NI", response_b_answer_snapshot: "Não informado",
        }],
      }],
    };
    const r = await (await loadAction())("proj-1");
    expect(["NI", "Não informado"]).toContain(gabaritoCell(r));
  });

  it("propaga o erro da leitura dos pares \"=\"", async () => {
    serverTableResults = {
      ...base(null, []),
      response_equivalences: [{ error: { message: "boom nos pares" } }],
    };
    const r = await (await loadAction())("proj-1");
    expect(r).toEqual({ error: "boom nos pares" });
  });

  it("em projeto de auto-revisão, a célula resolvida pela view entra no Gabarito", async () => {
    serverTableResults = {
      ...base("auto_review_llm", [resposta("h1", "humano", "Sim"), resposta("l", "llm", "Não")]),
      final_answers: [{ data: [{ document_id: "d1", field_name: "campo", provenance: "arbitrado", answer: "Não" }] }],
    };
    const r = await (await loadAction())("proj-1");
    expect(gabaritoCell(r)).toBe("Não");
  });

  it("propaga o erro da leitura de final_answers", async () => {
    serverTableResults = {
      ...base("auto_review_llm", []),
      final_answers: [{ error: { message: "boom na view" } }],
    };
    const r = await (await loadAction())("proj-1");
    expect(r).toEqual({ error: "boom na view" });
  });
});
