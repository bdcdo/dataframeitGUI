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
    makeSupabaseMock({
      tableResults: serverTableResults,
      writeCalls,
      rpcCalls,
    }),
}));

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
