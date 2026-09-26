import { describe, it, expect } from "vitest";
import {
  assembleExport,
  resolveOriginalHeaders,
  type AssembleInput,
  type ExportDocument,
  type ExportFinalAnswer,
  type ExportResponse,
  type ExportSheet,
} from "@/lib/export/assemble";
import type { EquivalenceRow } from "@/lib/compare-divergence";
import type { PydanticField } from "@/lib/types";
import { resolutionFixture } from "./error-resolution-fixture";

// --- Fixtures helpers ---

let fieldIdSeq = 0;
function nextFieldId(): string {
  fieldIdSeq += 1;
  return `00000000-0000-4000-8000-0000000000${String(fieldIdSeq).padStart(2, "0")}`;
}

function field(name: string, opts: Partial<PydanticField> = {}): PydanticField {
  return { id: nextFieldId(), name, type: "text", options: null, description: "", ...opts };
}

function doc(
  id: string,
  opts: {
    external_id?: string | null;
    title?: string | null;
    created_at?: string;
    columns?: string[];
    row?: Record<string, string>;
    textColumn?: string;
  } = {}
): ExportDocument {
  const {
    external_id = null,
    title = null,
    created_at = "2024-01-01T00:00:00Z",
    columns,
    row,
    textColumn,
  } = opts;
  const metadata =
    columns === undefined
      ? null
      : {
          original_columns: columns,
          original_row: row ?? Object.fromEntries(columns.map((c) => [c, ""])),
          ...(textColumn ? { text_column: textColumn } : {}),
        };
  return { id, external_id, title, created_at, metadata };
}

function run(overrides: Partial<AssembleInput> = {}) {
  const input: AssembleInput = {
    projectName: "Proj",
    fields: [],
    minResponses: 2,
    documents: [],
    responses: [],
    reviews: [],
    ...overrides,
  };
  return assembleExport(input);
}

// Índice de uma coluna pelo nome no header da planilha.
function idx(sheet: ExportSheet, name: string): number {
  const i = sheet.headers.indexOf(name);
  if (i === -1) throw new Error(`coluna ${name} ausente em [${sheet.headers}]`);
  return i;
}

// --- resolveOriginalHeaders (colisão/ordenação) ---

describe("resolveOriginalHeaders", () => {
  it("mantém colunas sem colisão", () => {
    expect(resolveOriginalHeaders(["a", "b"], new Set(["source"]))).toEqual([
      "a",
      "b",
    ]);
  });

  it("prefixa original_ ao colidir com nome reservado", () => {
    expect(
      resolveOriginalHeaders(["source", "nota"], new Set(["source", "nota"]))
    ).toEqual(["original_source", "original_nota"]);
  });

  it("acrescenta sufixo _2 em colisão persistente", () => {
    // 'source' vira 'original_source'; a coluna literal 'original_source' já
    // tomada vira 'original_source_2'.
    expect(
      resolveOriginalHeaders(
        ["source", "original_source"],
        new Set(["source"])
      )
    ).toEqual(["original_source", "original_source_2"]);
  });
});

// --- União e ordenação das colunas originais ---

describe("assembleExport — união ordenada das colunas originais", () => {
  it("une por created_at asc, primeira aparição vence", () => {
    const d = assembleExport({
      projectName: "P",
      fields: [],
      minResponses: 2,
      documents: [
        doc("B", { created_at: "2024-02-01", columns: ["b", "c"] }),
        doc("A", { created_at: "2024-01-01", columns: ["a", "b"] }),
      ],
      responses: [],
      reviews: [],
    });
    // A (jan) vem antes de B (fev): a, b (de A), depois c (novo de B).
    expect(d.documents.headers).toEqual(["document_id", "document_title", "a", "b", "c"]);
  });
});

// --- Colisão idêntica em CSV e aba Documentos ---

describe("assembleExport — colisão de nome de coluna", () => {
  it("renomeia consistentemente em Documentos e no CSV", () => {
    const d = run({
      fields: [field("nota")],
      documents: [doc("A", { columns: ["nota", "source", "tribunal"] })],
    });
    // 'nota' colide com campo do schema, 'source' com controle → prefixados.
    const expected = ["original_nota", "original_source", "tribunal"];
    const docsOriginals = d.documents.headers.slice(2); // após document_id/title
    expect(docsOriginals).toEqual(expected);
    // No CSV, as mesmas colunas originais aparecem após os 5 controles.
    const csvOriginals = d.csv.headers.slice(5, 5 + expected.length);
    expect(csvOriginals).toEqual(expected);
  });
});

// --- Auto-fill de concordância ---

describe("assembleExport — auto-fill de concordância", () => {
  it("preenche campo texto quando todas as respostas concordam (≥ minResponses)", () => {
    const d = run({
      fields: [field("campo")],
      documents: [doc("A")],
      responses: [
        { id: "resp-1", document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { campo: "sim" } },
        { id: "resp-2", document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { campo: "sim" } },
      ],
    });
    expect(d.verdicts.rows).toHaveLength(1);
    expect(d.verdicts.rows[0][idx(d.verdicts, "campo")]).toBe("sim");
  });

  it("não preenche quando há divergência", () => {
    const d = run({
      fields: [field("campo")],
      documents: [doc("A")],
      responses: [
        { id: "resp-3", document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { campo: "sim" } },
        { id: "resp-4", document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { campo: "nao" } },
      ],
    });
    expect(d.verdicts.rows).toHaveLength(0);
  });

  it("respeita minResponses: 1 resposta não gera gabarito", () => {
    const d = run({
      fields: [field("campo")],
      minResponses: 2,
      documents: [doc("A")],
      responses: [
        { id: "resp-5", document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { campo: "sim" } },
      ],
    });
    expect(d.verdicts.rows).toHaveLength(0);
  });

  it("campo multi concorda por conjuntos de opções", () => {
    const d = run({
      fields: [field("opts", { type: "multi", options: ["x", "y"] })],
      documents: [doc("A")],
      responses: [
        { id: "resp-6", document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { opts: ["x"] } },
        { id: "resp-7", document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { opts: ["x"] } },
      ],
    });
    expect(d.verdicts.rows[0][idx(d.verdicts, "opts")]).toBe("x");
  });

  it("campo multi diverge quando os conjuntos diferem", () => {
    const d = run({
      fields: [field("opts", { type: "multi", options: ["x", "y"] })],
      documents: [doc("A")],
      responses: [
        { id: "resp-8", document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { opts: ["x"] } },
        { id: "resp-9", document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { opts: ["y"] } },
      ],
    });
    expect(d.verdicts.rows).toHaveLength(0);
  });

  // A concordância também considera a união com as opções efetivamente
  // marcadas: uma opção removida do schema não pode ser ignorada e produzir um
  // auto-fill de concordância que os codificadores não têm (#484).
  it("campo multi diverge por opção fora das opções atuais", () => {
    const d = run({
      fields: [field("opts", { type: "multi", options: ["x"] })],
      documents: [doc("A")],
      responses: [
        { id: "resp-10", document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { opts: ["x", "z"] } },
        { id: "resp-11", document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { opts: ["x"] } },
      ],
    });
    expect(d.verdicts.rows).toHaveLength(0);
  });
});

// --- Prioridade veredicto > concordância > vazio ---

describe("assembleExport — prioridade do veredicto sobre a concordância", () => {
  it("veredicto explícito do revisor vence o auto-fill", () => {
    const d = run({
      fields: [field("campo")],
      documents: [doc("A")],
      responses: [
        { id: "resp-12", document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { campo: "concordado" } },
        { id: "resp-13", document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { campo: "concordado" } },
      ],
      reviews: [
        { document_id: "A", field_name: "campo", id: "rv1", created_at: "2026-01-01T00:00:00Z", field_hash: null, chosen_response_id: null, verdict: "pular", comment: "nota do revisor" },
      ],
    });
    const row = d.verdicts.rows[0];
    expect(row[idx(d.verdicts, "campo")]).toBe("[PULAR]");
    expect(row[idx(d.verdicts, "reviewer_comments")]).toBe("[campo] nota do revisor");
  });
});

// --- Linha source=documento ---

describe("assembleExport — linha source=documento", () => {
  it("gera linha documento só para doc sem resposta E sem gabarito", () => {
    const d = run({
      fields: [field("campo")],
      documents: [
        doc("A", { external_id: "EXT-A" }), // com resposta
        doc("B", { external_id: "EXT-B" }), // órfão
      ],
      responses: [
        { id: "resp-14", document_id: "A", respondent_name: "R1", respondent_type: "llm", answers: { campo: "v" } },
      ],
    });
    const sources = d.csv.rows.map((r) => r[idx(d.csv, "source")]);
    // A → linha 'llm'; B → linha 'documento'; nenhuma linha 'documento' para A.
    expect(sources).toContain("documento");
    const docRows = d.csv.rows.filter((r) => r[idx(d.csv, "source")] === "documento");
    expect(docRows).toHaveLength(1);
    expect(docRows[0][idx(d.csv, "document_id")]).toBe("EXT-B");
  });

  it("projeto sem respostas → só linhas documento, sem erro", () => {
    const d = run({
      documents: [doc("A"), doc("B")],
    });
    expect(d.responses.rows).toHaveLength(0);
    expect(d.verdicts.rows).toHaveLength(0);
    expect(d.csv.rows.every((r) => r[idx(d.csv, "source")] === "documento")).toBe(true);
    expect(d.csv.rows).toHaveLength(2);
  });
});

// --- Colunas originais repetidas nas linhas do mesmo doc ---

describe("assembleExport — colunas originais no CSV", () => {
  it("repete os valores originais em todas as linhas do mesmo documento", () => {
    const d = run({
      fields: [field("campo")],
      documents: [
        doc("A", {
          external_id: "EXT-A",
          columns: ["tribunal"],
          row: { tribunal: "TJSP" },
        }),
      ],
      responses: [
        { id: "resp-15", document_id: "A", respondent_name: "R1", respondent_type: "llm", answers: { campo: "a" } },
        { id: "resp-16", document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { campo: "b" } },
      ],
    });
    const tribunalCol = idx(d.csv, "tribunal");
    const rows = d.csv.rows.filter((r) => r[idx(d.csv, "document_id")] === "EXT-A");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r[tribunalCol] === "TJSP")).toBe(true);
  });
});

// --- US3: documentos antigos (metadata IS NULL) ---

describe("assembleExport — documentos antigos sem linha original (US3)", () => {
  it("base 100% antiga: nenhuma coluna original no header (só controle + schema)", () => {
    const d = run({
      fields: [field("campo")],
      documents: [doc("A"), doc("B")], // ambos com metadata null (sem `columns`)
    });
    // Sem colunas originais: aba Documentos = document_id + document_title só.
    expect(d.documents.headers).toEqual(["document_id", "document_title"]);
    // CSV = 5 controles + campo do schema + reviewer_comments (sem originais).
    expect(d.csv.headers).toEqual([
      "document_id",
      "document_title",
      "respondent",
      "respondent_type",
      "source",
      "campo",
      "reviewer_comments",
    ]);
  });

  it("base mista: header = união dos docs novos; antigos com células vazias", () => {
    const d = run({
      fields: [],
      documents: [
        doc("OLD", { external_id: "EXT-OLD", created_at: "2024-01-01" }), // metadata null
        doc("NEW", {
          external_id: "EXT-NEW",
          created_at: "2024-01-02",
          columns: ["tribunal"],
          row: { tribunal: "TJSP" },
        }),
      ],
    });
    const tribunalCol = idx(d.documents, "tribunal");
    const rowOld = d.documents.rows.find((r) => r[0] === "EXT-OLD")!;
    const rowNew = d.documents.rows.find((r) => r[0] === "EXT-NEW")!;
    // Doc antigo: coluna original existe no header mas vazia; novo: preenchida.
    expect(rowOld[tribunalCol]).toBe("");
    expect(rowNew[tribunalCol]).toBe("TJSP");
  });

  it("doc antigo sem resposta ainda gera linha source=documento", () => {
    const d = run({
      documents: [doc("OLD", { external_id: "EXT-OLD" })],
    });
    expect(d.csv.rows).toHaveLength(1);
    expect(d.csv.rows[0][idx(d.csv, "source")]).toBe("documento");
    expect(d.csv.rows[0][idx(d.csv, "document_id")]).toBe("EXT-OLD");
  });
});

// --- Achado C1: descarta respostas/reviews de docs fora da base ---

describe("assembleExport — filtra à base exportada (achado C1)", () => {
  it("nenhuma linha referencia documento ausente da base", () => {
    const d = run({
      fields: [field("campo")],
      documents: [doc("A", { external_id: "EXT-A" })],
      // resposta e review de um doc 'ghost' que não está na base (ex.: excluído).
      responses: [
        { id: "resp-17", document_id: "A", respondent_name: "R1", respondent_type: "llm", answers: { campo: "v" } },
        { id: "resp-18", document_id: "ghost", respondent_name: "RX", respondent_type: "llm", answers: { campo: "x" } },
      ],
      reviews: [
        { document_id: "ghost", field_name: "campo", id: "rv1", created_at: "2026-01-01T00:00:00Z", field_hash: null, chosen_response_id: null, verdict: "ambiguo", comment: null },
      ],
    });
    const allIds = new Set([
      ...d.csv.rows.map((r) => r[idx(d.csv, "document_id")]),
      ...d.responses.rows.map((r) => r[idx(d.responses, "document_id")]),
      ...d.verdicts.rows.map((r) => r[idx(d.verdicts, "document_id")]),
      ...d.documents.rows.map((r) => r[idx(d.documents, "document_id")]),
    ]);
    expect(allIds.has("ghost")).toBe(false);
    expect(allIds.has("EXT-A")).toBe(true);
  });
});

// --- Texto só na aba Documentos (correção pós-revisão do PR #432) ---

describe("assembleExport — inteiro teor só na aba Documentos", () => {
  it("coluna de texto vira document_text na aba Documentos e some do CSV", () => {
    const d = run({
      fields: [field("campo")],
      documents: [
        doc("A", {
          external_id: "EXT-A",
          columns: ["texto", "tribunal"],
          row: { texto: "Inteiro teor longo", tribunal: "TJSP" },
          textColumn: "texto",
        }),
      ],
      responses: [
        { id: "resp-19", document_id: "A", respondent_name: "R1", respondent_type: "llm", answers: { campo: "a" } },
        { id: "resp-20", document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { campo: "b" } },
      ],
    });

    // Aba Documentos: 'texto' NÃO aparece como coluna original; há document_text.
    expect(d.documents.headers).not.toContain("texto");
    expect(d.documents.headers).toContain("document_text");
    expect(d.documents.headers).toContain("tribunal");
    const docRow = d.documents.rows.find((r) => r[0] === "EXT-A")!;
    expect(docRow[idx(d.documents, "document_text")]).toBe("Inteiro teor longo");
    expect(docRow[idx(d.documents, "tribunal")]).toBe("TJSP");

    // CSV unificado: sem coluna de texto nem document_text; a auxiliar 'tribunal'
    // segue repetida por linha (2 linhas do doc A).
    expect(d.csv.headers).not.toContain("texto");
    expect(d.csv.headers).not.toContain("document_text");
    expect(d.csv.headers).toContain("tribunal");
    const csvRows = d.csv.rows.filter((r) => r[idx(d.csv, "document_id")] === "EXT-A");
    expect(csvRows).toHaveLength(2);
    expect(csvRows.every((r) => r[idx(d.csv, "tribunal")] === "TJSP")).toBe(true);
    // O inteiro teor não aparece em nenhuma célula do CSV.
    expect(
      d.csv.rows.some((r) => r.some((cell) => cell === "Inteiro teor longo"))
    ).toBe(false);
  });

  it("document_text colide com coluna auxiliar homônima → original_document_text", () => {
    const d = run({
      documents: [
        doc("A", {
          external_id: "EXT-A",
          columns: ["conteudo", "document_text"],
          row: { conteudo: "TEOR", document_text: "auxiliar" },
          textColumn: "conteudo",
        }),
      ],
    });
    // A coluna de texto ('conteudo') vira a coluna dedicada document_text; a
    // coluna auxiliar literal 'document_text' é renomeada para não colidir.
    expect(d.documents.headers).toContain("document_text");
    expect(d.documents.headers).toContain("original_document_text");
    const docRow = d.documents.rows[0];
    expect(docRow[idx(d.documents, "document_text")]).toBe("TEOR");
    expect(docRow[idx(d.documents, "original_document_text")]).toBe("auxiliar");
  });

  it("preserva coluna auxiliar homônima à coluna de texto de outro documento", () => {
    const d = run({
      documents: [
        doc("A", {
          external_id: "EXT-A",
          columns: ["texto", "tribunal"],
          row: { texto: "Inteiro teor de A", tribunal: "TJSP" },
          textColumn: "texto",
        }),
        doc("B", {
          external_id: "EXT-B",
          columns: ["conteudo", "texto"],
          row: { conteudo: "Inteiro teor de B", texto: "dado auxiliar" },
          textColumn: "conteudo",
        }),
      ],
    });

    expect(d.documents.headers).toContain("texto");
    expect(d.csv.headers).toContain("texto");

    const docA = d.documents.rows.find((row) => row[0] === "EXT-A")!;
    const docB = d.documents.rows.find((row) => row[0] === "EXT-B")!;
    expect(docA[idx(d.documents, "texto")]).toBe("");
    expect(docA[idx(d.documents, "document_text")]).toBe("Inteiro teor de A");
    expect(docB[idx(d.documents, "texto")]).toBe("dado auxiliar");
    expect(docB[idx(d.documents, "document_text")]).toBe("Inteiro teor de B");

    const csvA = d.csv.rows.find((row) => row[0] === "EXT-A")!;
    const csvB = d.csv.rows.find((row) => row[0] === "EXT-B")!;
    expect(csvA[idx(d.csv, "texto")]).toBe("");
    expect(csvB[idx(d.csv, "texto")]).toBe("dado auxiliar");
    expect(d.csv.rows.some((row) => row.includes("Inteiro teor de A"))).toBe(false);
    expect(d.csv.rows.some((row) => row.includes("Inteiro teor de B"))).toBe(false);
  });

  it("doc sem text_column mantém comportamento antigo (toda coluna é auxiliar)", () => {
    // Guarda de retrocompatibilidade: metadata sem text_column (legado/NULL) não
    // cria document_text e não omite nenhuma coluna.
    const d = run({
      documents: [
        doc("A", {
          external_id: "EXT-A",
          columns: ["texto", "tribunal"],
          row: { texto: "conteúdo", tribunal: "TJSP" },
        }),
      ],
    });
    expect(d.documents.headers).toEqual([
      "document_id",
      "document_title",
      "texto",
      "tribunal",
    ]);
    expect(d.documents.headers).not.toContain("document_text");
    expect(d.csv.headers).toContain("texto");
  });
});

// --- Validade do veredito (#758): a pergunta, não a rodada ---

describe("assembleExport: validade do veredito (#758)", () => {
  const HASH = "aaaaaaaaaaaa";
  const base = {
    fields: [field("campo", { hash: HASH })],
    documents: [doc("A")],
    responses: [
      { id: "resp-21", document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { campo: "sim" } },
      { id: "resp-22", document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { campo: "sim" } },
    ],
  };
  const review = (overrides: Partial<{ id: string; verdict: string; comment: string | null; created_at: string; field_hash: string | null; chosen_response_id: string | null }> = {}) => ({
    id: "rv1", document_id: "A", field_name: "campo", verdict: "não", comment: null,
    created_at: "2026-01-01T00:00:00Z", field_hash: HASH, chosen_response_id: null, ...overrides,
  });

  it("veredito de rodada anterior sobre a mesma pergunta prevalece sobre a concordância", () => {
    // Não há rodada na review: a regra não a lê, e a pergunta é a mesma.
    const d = run({ ...base, reviews: [review({ comment: "antigo" })] });
    const row = d.verdicts.rows[0];
    expect(row[idx(d.verdicts, "campo")]).toBe("não");
    expect(row[idx(d.verdicts, "reviewer_comments")]).toBe("[campo] antigo");
  });

  it("veredito sobre outra versão da pergunta não entra: a célula cai para a concordância", () => {
    const d = run({ ...base, reviews: [review({ comment: "antigo", field_hash: "ffffffffffff" })] });
    const row = d.verdicts.rows[0];
    expect(row[idx(d.verdicts, "campo")]).toBe("sim");
    expect(row[idx(d.verdicts, "reviewer_comments")]).toBe("");
  });

  it("veredito legado fora das opções atuais não entra", () => {
    const d = run({
      ...base,
      fields: [field("campo", { type: "single", options: ["sim", "não"], hash: HASH })],
      reviews: [review({ verdict: "talvez", field_hash: null })],
    });
    expect(d.verdicts.rows[0][idx(d.verdicts, "campo")]).toBe("sim");
  });

  it("resposta nova digitada com o hash atual entra mesmo fora das opções; copiada não", () => {
    const single = { ...base, fields: [field("campo", { type: "single", options: ["sim", "não"], hash: HASH })] };
    const typed = run({ ...single, reviews: [review({ verdict: "talvez", chosen_response_id: null })] });
    expect(typed.verdicts.rows[0][idx(typed.verdicts, "campo")]).toBe("talvez");
    const copied = run({ ...single, reviews: [review({ verdict: "talvez", chosen_response_id: "r1" })] });
    expect(copied.verdicts.rows[0][idx(copied.verdicts, "campo")]).toBe("sim");
  });

  it("entre vereditos válidos da célula vence o mais recente por created_at", () => {
    const d = run({
      ...base,
      reviews: [
        review({ id: "z", verdict: "velho", created_at: "2026-01-01T00:00:00Z" }),
        review({ id: "a", verdict: "novo", created_at: "2026-02-01T00:00:00Z" }),
      ],
    });
    expect(d.verdicts.rows[0][idx(d.verdicts, "campo")]).toBe("novo");
  });

  // A decisão com valor próprio é um julgamento novo sobre as respostas e a
  // pergunta atuais; "Ambos corretos" e "Em discussão" dependem do veredito.
  describe("decisão do LLM Insights ancorada em veredito", () => {
    const decisionBase = {
      fields: [field("x", { hash: HASH })],
      documents: [doc("doc1")],
      responses: [
        { id: "resp-23", document_id: "doc1", respondent_name: "LLM", respondent_type: "llm", answers: { x: "LLM" } },
        { id: "resp-24", document_id: "doc1", respondent_name: "R1", respondent_type: "codificacao", answers: { x: "Humano" } },
      ],
    };
    const source = (field_hash: string) => ({
      id: "review1", document_id: "doc1", field_name: "x", verdict: "Humano", comment: null,
      created_at: "2026-01-01T00:00:00Z", field_hash, chosen_response_id: "rh",
    });

    it("Erro do LLM sobre veredito inválido continua no gabarito", () => {
      const d = run({ ...decisionBase, reviews: [source("ffffffffffff")], errorResolutions: [resolutionFixture("researchers_correct")] });
      expect(d.verdicts.rows).toHaveLength(1);
      expect(d.verdicts.rows[0][idx(d.verdicts, "x")]).toBe("Veredito");
    });

    // Sobre veredito inválido, `read_error_resolutions` não dá contexto
    // corrente à decisão que depende da fonte.
    it.each([
      ["válido", HASH, "Em discussão", "", resolutionFixture("discussion")],
      ["inválido", "ffffffffffff", "", undefined, { ...resolutionFixture("discussion"), current_context: null }],
    ])("Em discussão sobre veredito %s", (_label, hash, comment, cell, resolution) => {
      const d = run({ ...decisionBase, reviews: [source(hash)], errorResolutions: [resolution] });
      if (cell === undefined) {
        // Sem veredito válido nem concordância nem decisão: a linha nem existe.
        expect(d.verdicts.rows).toHaveLength(0);
        return;
      }
      expect(d.verdicts.rows[0][idx(d.verdicts, "x")]).toBe(cell);
      expect(d.verdicts.rows[0][idx(d.verdicts, "reviewer_comments")]).toContain(comment);
    });

    it("Ambos corretos sobre veredito válido anota a célula; sobre inválido, nem a linha existe", () => {
      const valid = run({ ...decisionBase, reviews: [source(HASH)], errorResolutions: [resolutionFixture("both_correct")] });
      expect(valid.verdicts.rows[0][idx(valid.verdicts, "x")]).toBe("Humano");
      expect(valid.verdicts.rows[0][idx(valid.verdicts, "reviewer_comments")]).toContain("Ambos corretos");
      const stale = run({ ...decisionBase, reviews: [source("ffffffffffff")],
        errorResolutions: [{ ...resolutionFixture("both_correct"), current_context: null }] });
      expect(stale.verdicts.rows).toHaveLength(0);
    });

    // A fonte vale mesmo sem ser a review escolhida da célula: outro revisor
    // arbitrou depois, e os dois vereditos valem.
    it("Em discussão ancorada no veredito válido mais antigo da célula bloqueia o gabarito", () => {
      const newer = { ...source(HASH), id: "review2", created_at: "2026-02-01T00:00:00Z" };
      const d = run({ ...decisionBase, reviews: [newer, source(HASH)], errorResolutions: [resolutionFixture("discussion")] });
      expect(d.verdicts.rows[0][idx(d.verdicts, "x")]).toBe("");
      expect(d.verdicts.rows[0][idx(d.verdicts, "reviewer_comments")]).toContain("Em discussão");
    });
  });
});

// --- Células sem veredito: auto-revisão, grupos "=" e Pendências ---

describe("assembleExport: células sem veredito", () => {
  const resp = (id: string, type: "humano" | "llm", value: unknown, docId = "A"): ExportResponse => ({
    id, document_id: docId, respondent_name: id, respondent_type: type, answers: { campo: value },
  });
  // Par "=" com os snapshots iguais às respostas atuais, salvo quando o teste
  // passa outro.
  const pair = (a: ExportResponse, b: ExportResponse, snapA: unknown = a.answers?.campo): EquivalenceRow => ({
    id: `${a.id}-${b.id}`, document_id: a.document_id, field_name: "campo", response_a_id: a.id, response_b_id: b.id,
    reviewer_id: null, response_a_answer_snapshot: snapA, response_b_answer_snapshot: b.answers?.campo,
  });
  const exported = (overrides: Partial<AssembleInput>) =>
    run({ fields: [field("campo")], documents: [doc("A")], ...overrides });
  const cellOf = (d: ReturnType<typeof run>, docId = "A") =>
    d.verdicts.rows.find((r) => r[0] === docId)?.[idx(d.verdicts, "campo")] ?? "";
  const pendingOf = (d: ReturnType<typeof run>) => d.pending.rows.map((r) => [r[0], r[2], r[3]]);

  it("par \"=\" entre humanos, LLM fora do grupo: vence a forma mais frequente", () => {
    const [h1, h2, h3, llm] = [resp("h1", "humano", "NI"), resp("h2", "humano", "NI"), resp("h3", "humano", "Ausente"), resp("l", "llm", "Sim")];
    const d = exported({ responses: [h1, h2, h3, llm], equivalences: [pair(h3, h1)] });
    expect(cellOf(d)).toBe("NI");
    expect(d.pending.rows).toEqual([]);
  });

  it("empate de frequência cai na ordem alfabética, qualquer que seja a ordem das linhas", () => {
    const [h1, h2, llm] = [resp("h1", "humano", "NI"), resp("h2", "humano", "Ausente"), resp("l", "llm", "Sim")];
    const equivalences = [pair(h1, h2)];
    expect(cellOf(exported({ responses: [h1, h2, llm], equivalences }))).toBe("Ausente");
    expect(cellOf(exported({ responses: [llm, h2, h1], equivalences }))).toBe("Ausente");
  });

  it("LLM no grupo \"=\": a célula recebe a forma do LLM, mesmo minoritária", () => {
    const [h1, h2, llm] = [resp("h1", "humano", "NI"), resp("h2", "humano", "NI"), resp("l", "llm", "Não informado")];
    const d = exported({ responses: [h1, h2, llm], equivalences: [pair(h1, llm)] });
    expect(cellOf(d)).toBe("Não informado");
  });

  it("dois humanos concordam e o LLM diverge: vale o consenso humano", () => {
    const d = exported({ responses: [resp("h1", "humano", "Sim"), resp("h2", "humano", "sim "), resp("l", "llm", "Não")] });
    expect(cellOf(d)).toBe("Sim");
    // O CSV repete a linha do Gabarito.
    const csvRow = d.csv.rows.find((r) => r[idx(d.csv, "source")] === "comparacao")!;
    expect(csvRow[idx(d.csv, "campo")]).toBe("Sim");
  });

  it("multi: humanos com o mesmo conjunto e LLM divergente preenchem", () => {
    const multi = field("campo", { type: "multi", options: ["a", "b", "c"] });
    const d = exported({
      fields: [multi],
      responses: [resp("h1", "humano", ["b", "a"]), resp("h2", "humano", ["a", "b"]), resp("l", "llm", ["c"])],
    });
    expect(cellOf(d)).toBe("a; b");
  });

  it("um humano e o LLM divergentes: fica em branco e vai para Pendências", () => {
    const d = exported({ responses: [resp("h1", "humano", "Sim"), resp("l", "llm", "Não")] });
    expect(d.verdicts.rows).toEqual([]);
    expect(pendingOf(d)).toEqual([["A", "campo", "aguarda arbitragem"]]);
  });

  it("par \"=\" com snapshot desatualizado não funde", () => {
    const [h1, h2, llm] = [resp("h1", "humano", "NI"), resp("h2", "humano", "N/A"), resp("l", "llm", "Sim")];
    const d = exported({ responses: [h1, h2, llm], equivalences: [pair(h1, h2, "Não informado")] });
    expect(cellOf(d)).toBe("");
    expect(pendingOf(d)).toEqual([["A", "campo", "divergência entre pesquisadores"]]);
  });

  describe("campo condicional: a linha do Gabarito decide se ele se aplica", () => {
    // `filho` só aparece para quem responde "sim" em `pai`, e `neto` só para
    // quem responde "Sim" em `filho`.
    const pai = field("pai");
    const filho = field("filho", { condition: { field: "pai", equals: "sim" } });
    const neto = field("neto", { condition: { field: "filho", equals: "Sim" } });
    const answering = (id: string, type: "humano" | "llm", answers: Record<string, unknown>): ExportResponse => ({
      id, document_id: "A", respondent_name: id, respondent_type: type, answers,
    });
    // Veredito do revisor sobre o pai: fixa o valor dele no Gabarito
    // independentemente das respostas.
    const paiVerdict = (verdict: string) => ({
      id: `rv-${verdict}`, document_id: "A", field_name: "pai", verdict, comment: null,
      created_at: "2026-01-01T00:00:00Z", field_hash: null, chosen_response_id: null,
    });
    const withChain = (overrides: Partial<AssembleInput>) => exported({ fields: [pai, filho, neto], ...overrides });
    const cell = (d: ReturnType<typeof run>, name: string) =>
      d.verdicts.rows.find((r) => r[0] === "A")?.[idx(d.verdicts, name)] ?? "";

    it("pai exportado satisfaz a condição: o filho segue as regras de valor", () => {
      const d = withChain({
        responses: [
          answering("h1", "humano", { pai: "sim", filho: "Sim" }),
          answering("h2", "humano", { pai: "sim", filho: "Sim" }),
          answering("l", "llm", { pai: "sim", filho: "Não" }),
        ],
      });
      expect(cell(d, "filho")).toBe("Sim");
      expect(d.pending.rows).toEqual([]);
    });

    it("pai exportado não satisfaz: o filho que só um pesquisador viu fica em branco, sem pendência", () => {
      const d = withChain({
        responses: [
          answering("h1", "humano", { pai: "sim", filho: "Sim" }),
          answering("h2", "humano", { pai: "não" }),
          answering("l", "llm", { pai: "não" }),
        ],
        reviews: [paiVerdict("não")],
      });
      expect(cell(d, "pai")).toBe("não");
      expect(cell(d, "filho")).toBe("");
      expect(d.pending.rows).toEqual([]);
    });

    it("pai decidido pelos pesquisadores contra o LLM: o filho que só o LLM viu fica em branco", () => {
      const d = withChain({
        responses: [
          answering("h1", "humano", { pai: "não" }),
          answering("h2", "humano", { pai: "não" }),
          answering("l", "llm", { pai: "sim", filho: "Sim" }),
        ],
      });
      expect(cell(d, "filho")).toBe("");
      expect(d.pending.rows).toEqual([]);
    });

    it("pai pendente: o filho vai para as Pendências esperando por ele", () => {
      const d = withChain({
        responses: [
          answering("h1", "humano", { pai: "sim", filho: "Sim" }),
          answering("h2", "humano", { pai: "não" }),
          answering("l", "llm", { pai: "sim", filho: "Sim" }),
        ],
      });
      expect(pendingOf(d)).toEqual([
        ["A", "pai", "divergência entre pesquisadores"],
        ["A", "filho", "aguarda o campo pai"],
        ["A", "neto", "aguarda o campo filho"],
      ]);
    });

    it("pai com veredito \"ambíguo\" não é valor: o filho espera", () => {
      const d = withChain({
        responses: [answering("h1", "humano", { pai: "sim", filho: "Sim" }), answering("h2", "humano", { pai: "sim", filho: "Sim" })],
        reviews: [paiVerdict("ambiguo")],
      });
      expect(pendingOf(d)).toEqual([["A", "filho", "aguarda o campo pai"], ["A", "neto", "aguarda o campo filho"]]);
    });

    it("condição encadeada: o neto segue o filho exportado", () => {
      const full = { pai: "sim", filho: "Sim", neto: "x" };
      const applies = withChain({ responses: [answering("h1", "humano", full), answering("h2", "humano", full)] });
      expect(cell(applies, "neto")).toBe("x");
      // Filho em branco legítimo: o neto também, sem pendência.
      const blank = withChain({
        responses: [answering("h1", "humano", full), answering("h2", "humano", { pai: "não" })],
        reviews: [paiVerdict("não")],
      });
      expect(cell(blank, "neto")).toBe("");
      expect(blank.pending.rows).toEqual([]);
    });

    it("pai multi: a condição testa a lista exportada", () => {
      const multiPai = field("pai", { type: "multi", options: ["a", "b"] });
      const filhoDeB = field("filho", { condition: { field: "pai", in: ["b"] } });
      const d = exported({
        fields: [multiPai, filhoDeB],
        responses: [
          answering("h1", "humano", { pai: ["a", "b"], filho: "Sim" }),
          answering("h2", "humano", { pai: ["b", "a"], filho: "Sim" }),
        ],
      });
      expect(cell(d, "filho")).toBe("Sim");
    });

    it("só o LLM respondeu: não preenche e vai para as Pendências", () => {
      // O campo foi criado depois da codificação humana, e o LLM rodou depois.
      const before = { answer_field_hashes: { outro: "h" } };
      const d = exported({
        fields: [pai],
        responses: [
          { ...answering("h1", "humano", {}), ...before },
          { ...answering("h2", "humano", {}), ...before },
          answering("l", "llm", { pai: "sim" }),
        ],
      });
      expect(cell(d, "pai")).toBe("");
      expect(pendingOf(d)).toEqual([["A", "pai", "só o LLM respondeu"]]);
      // Também quando só o LLM viu o filho de um pai decidido.
      const conditional = withChain({
        responses: [answering("h1", "humano", { pai: "não" }), answering("l", "llm", { pai: "sim", filho: "Sim" })],
        reviews: [paiVerdict("sim")],
      });
      expect(cell(conditional, "filho")).toBe("");
      expect(pendingOf(conditional)).toEqual([["A", "filho", "só o LLM respondeu"], ["A", "neto", "aguarda o campo filho"]]);
    });

    it("ninguém respondeu o campo que a linha diz aplicável: vai para as Pendências", () => {
      // O veredito pôs no pai um valor que nenhum respondente escolheu.
      const d = withChain({
        responses: [
          answering("h1", "humano", { pai: "não" }),
          answering("h2", "humano", { pai: "não" }),
          answering("l", "llm", { pai: "não" }),
        ],
        reviews: [paiVerdict("sim")],
      });
      expect(cell(d, "pai")).toBe("sim");
      expect(cell(d, "filho")).toBe("");
      expect(pendingOf(d)).toEqual([["A", "filho", "ninguém respondeu o campo"], ["A", "neto", "aguarda o campo filho"]]);
      // Também quando o campo nasceu depois de toda a codificação.
      const before = { answer_field_hashes: { outro: "h" } };
      const late = exported({
        fields: [pai],
        responses: [{ ...answering("h1", "humano", {}), ...before }, { ...answering("h2", "humano", {}), ...before }],
      });
      expect(pendingOf(late)).toEqual([["A", "pai", "ninguém respondeu o campo"]]);
    });

    describe("julgamento explícito diante da condição", () => {
      const verdictOn = (fieldName: string, verdict: string) => ({
        ...paiVerdict(verdict), id: `rv-${fieldName}-${verdict}`, field_name: fieldName,
      });
      const contradicted = [
        answering("h1", "humano", { pai: "sim", filho: "Sim" }),
        answering("h2", "humano", { pai: "não" }),
        answering("l", "llm", { pai: "não" }),
      ];

      it("veredito no filho com o pai no Gabarito sem cumprir a condição: branco e Pendências", () => {
        const d = withChain({ responses: contradicted, reviews: [paiVerdict("não"), verdictOn("filho", "Sim")] });
        expect(cell(d, "pai")).toBe("não");
        expect(cell(d, "filho")).toBe("");
        // O filho sai da linha como não aplicável: o neto fica no branco
        // legítimo, sem esperar por ele.
        expect(cell(d, "neto")).toBe("");
        expect(pendingOf(d)).toEqual([["A", "filho", "julgamento contradiz o campo pai"]]);
      });

      it("veredito em branco no filho não contradiz o pai", () => {
        const d = withChain({ responses: contradicted, reviews: [paiVerdict("não"), verdictOn("filho", "")] });
        expect(cell(d, "filho")).toBe("");
        expect(d.pending.rows).toEqual([]);
      });

      // "Ambíguo" e "pular" não afirmam valor: entram como antes da regra, e o
      // neto espera pelo filho, que não é valor.
      it.each([["ambiguo", "[AMBIGUO]"], ["pular", "[PULAR]"]])(
        "veredito %s no filho não contradiz o pai",
        (verdict, label) => {
          const d = withChain({ responses: contradicted, reviews: [paiVerdict("não"), verdictOn("filho", verdict)] });
          expect(cell(d, "filho")).toBe(label);
          expect(pendingOf(d)).toEqual([["A", "neto", "aguarda o campo filho"]]);
        },
      );

      it("veredito no filho com o pai pendente: entra, porque não há o que contradizer", () => {
        const d = withChain({
          responses: [
            answering("h1", "humano", { pai: "sim", filho: "Sim" }),
            answering("h2", "humano", { pai: "não" }),
            answering("l", "llm", { pai: "sim", filho: "Sim" }),
          ],
          reviews: [verdictOn("filho", "Sim")],
        });
        expect(cell(d, "filho")).toBe("Sim");
        expect(pendingOf(d)).toEqual([["A", "pai", "divergência entre pesquisadores"]]);
      });

      it("auto-revisão decidida no filho contradizendo o pai: branco e Pendências", () => {
        const d = withChain({
          responses: [answering("h1", "humano", { pai: "não" }), answering("l", "llm", { pai: "sim", filho: "Sim" })],
          reviews: [paiVerdict("não")],
          finalAnswers: [{ document_id: "A", field_name: "filho", provenance: "arbitrado", answer: "Sim" }],
        });
        expect(cell(d, "filho")).toBe("");
        expect(pendingOf(d)).toEqual([["A", "filho", "julgamento contradiz o campo pai"]]);
      });

      it("auto-revisão decidida no filho com o pai pendente: entra", () => {
        const d = withChain({
          responses: [
            answering("h1", "humano", { pai: "sim", filho: "Sim" }),
            answering("h2", "humano", { pai: "não" }),
            answering("l", "llm", { pai: "sim", filho: "Não" }),
          ],
          finalAnswers: [{ document_id: "A", field_name: "filho", provenance: "arbitrado", answer: "Sim" }],
        });
        expect(cell(d, "filho")).toBe("Sim");
        expect(pendingOf(d)).toEqual([["A", "pai", "divergência entre pesquisadores"]]);
      });

      // A decisão do LLM Insights chega pelo mesmo mapa dos vereditos
      // (`applyExportResolutions`), e a regra vale igual para ela.
      it("decisão do LLM Insights no filho contradizendo o pai: branco e Pendências", () => {
        const x = field("x", { condition: { field: "pai", equals: "sim" } });
        const d = exported({
          fields: [pai, x],
          documents: [doc("doc1")],
          responses: [
            { id: "rllm", document_id: "doc1", respondent_name: "LLM", respondent_type: "llm", answers: { pai: "sim", x: "LLM" } },
            { id: "rh", document_id: "doc1", respondent_name: "R1", respondent_type: "humano", answers: { pai: "sim", x: "Humano" } },
          ],
          reviews: [{ ...paiVerdict("não"), document_id: "doc1" }],
          errorResolutions: [resolutionFixture("llm_correct")],
        });
        const row = d.verdicts.rows.find((r) => r[0] === "doc1")!;
        expect(row[idx(d.verdicts, "x")]).toBe("");
        expect(row[idx(d.verdicts, "reviewer_comments")]).toContain("Erro humano");
        expect(pendingOf(d)).toEqual([["doc1", "x", "julgamento contradiz o campo pai"]]);
      });
    });

    it("um único pesquisador viu o filho: a célula recebe a resposta dele", () => {
      const d = withChain({
        responses: [
          answering("h1", "humano", { pai: "sim", filho: "Talvez" }),
          answering("h2", "humano", { pai: "não" }),
          answering("l", "llm", { pai: "não" }),
        ],
        reviews: [paiVerdict("sim")],
      });
      expect(cell(d, "filho")).toBe("Talvez");
      expect(pendingOf(d)).toEqual([]);
    });

    it("quem respondeu o pai com outro valor não conta como divergente", () => {
      // O valor antigo do filho em h3 divergiria dos demais se contasse.
      const d = withChain({
        responses: [
          answering("h1", "humano", { pai: "sim", filho: "Sim" }),
          answering("h2", "humano", { pai: "sim", filho: "Sim" }),
          answering("h3", "humano", { pai: "não", filho: "Não" }),
          answering("l", "llm", { pai: "sim", filho: "Sim" }),
        ],
        reviews: [paiVerdict("sim")],
      });
      expect(cell(d, "filho")).toBe("Sim");
      expect(pendingOf(d)).toEqual([]);
    });

    it("o mínimo de dois pesquisadores conta só quem viu o campo", () => {
      const d = withChain({
        responses: [
          answering("h1", "humano", { pai: "não" }),
          answering("h2", "humano", { pai: "sim", filho: "Sim" }),
          answering("l", "llm", { pai: "sim", filho: "Não" }),
        ],
        reviews: [paiVerdict("sim")],
      });
      expect(cell(d, "filho")).toBe("");
      expect(pendingOf(d)).toEqual([["A", "filho", "aguarda arbitragem"], ["A", "neto", "aguarda o campo filho"]]);
    });
  });

  describe("opção de preencher com o LLM onde nenhum pesquisador respondeu", () => {
    // `pai` é respondido por todos; `extra` nasceu depois da codificação
    // humana e só o LLM o respondeu; `interno` é `llm_only`; `oculto`, `none`.
    const pai = field("pai");
    const extra = field("extra");
    const interno = field("interno", { target: "llm_only" });
    const oculto = field("oculto", { target: "none" });
    const before = { answer_field_hashes: { pai: "h" } };
    const human = (id: string): ExportResponse => ({
      id, document_id: "A", respondent_name: id, respondent_type: "humano", answers: { pai: "sim" }, ...before,
    });
    const llm = (answers: Record<string, unknown>): ExportResponse => ({
      id: "l", document_id: "A", respondent_name: "LLM", respondent_type: "llm", answers,
    });
    const base = (overrides: Partial<AssembleInput> = {}) => exported({
      fields: [pai, extra, interno, oculto],
      responses: [human("h1"), human("h2"), llm({ pai: "sim", extra: "do LLM", interno: "só dele", oculto: "x" })],
      ...overrides,
    });
    const cell = (d: ReturnType<typeof run>, name: string) =>
      d.verdicts.rows.find((r) => r[0] === "A")?.[idx(d.verdicts, name)] ?? "";

    it("desligada: a célula só do LLM segue nas Pendências, e o campo llm_only fica fora", () => {
      const d = base();
      expect(cell(d, "extra")).toBe("");
      expect(pendingOf(d)).toEqual([["A", "extra", "só o LLM respondeu"]]);
      expect(d.llmOnly.rows).toEqual([]);
      expect(d.verdicts.headers).not.toContain("interno");
      expect(d.responses.headers).not.toContain("interno");
    });

    it("ligada: a célula recebe o valor do LLM, sai das Pendências e entra em \"Só LLM\"", () => {
      const d = base({ fillFromLlm: true });
      expect(cell(d, "pai")).toBe("sim");
      expect(cell(d, "extra")).toBe("do LLM");
      expect(d.pending.rows).toEqual([]);
      expect(d.llmOnly.headers).toEqual(["document_id", "document_title", "campo"]);
      expect(d.llmOnly.rows).toEqual([["A", "", "extra"], ["A", "", "interno"]]);
    });

    it("ligada: o campo llm_only entra nas colunas e o none continua fora", () => {
      const d = base({ fillFromLlm: true });
      expect(cell(d, "interno")).toBe("só dele");
      expect(d.verdicts.headers).toContain("interno");
      const llmRow = d.responses.rows.find((r) => r[idx(d.responses, "respondent_type")] === "llm")!;
      expect(llmRow[idx(d.responses, "interno")]).toBe("só dele");
      expect(d.verdicts.headers).not.toContain("oculto");
      expect(d.responses.headers).not.toContain("oculto");
      expect(d.csv.headers).not.toContain("oculto");
    });

    it("ligada: o branco do pesquisador legado no campo llm_only não diverge do LLM", () => {
      // Sem `answer_field_hashes`, a resposta conta como tendo visto todo campo.
      const legacy = (id: string): ExportResponse => ({
        id, document_id: "A", respondent_name: id, respondent_type: "humano", answers: { pai: "sim" },
      });
      const d = base({ fillFromLlm: true, fields: [pai, interno], responses: [legacy("h1"), legacy("h2"), llm({ pai: "sim", interno: "só dele" })] });
      expect(cell(d, "interno")).toBe("só dele");
      expect(d.pending.rows).toEqual([]);
      expect(d.llmOnly.rows).toEqual([["A", "", "interno"]]);
    });

    it("ligada: resposta do LLM em branco não preenche e segue nas Pendências", () => {
      const d = base({
        fillFromLlm: true,
        responses: [human("h1"), human("h2"), llm({ pai: "sim", extra: "", interno: "só dele" })],
      });
      expect(cell(d, "extra")).toBe("");
      expect(pendingOf(d)).toEqual([["A", "extra", "só o LLM respondeu"]]);
      expect(d.llmOnly.rows).toEqual([["A", "", "interno"]]);
    });

    describe("a célula do LLM não decide a condição de quem tem pesquisador ou julgamento", () => {
      // `f` só se aplica com `interno` = "sim", e `interno` é `llm_only`: sem a
      // opção, ele nunca se decide, e com ela o LLM o preenche com "não".
      const f = field("f", { condition: { field: "interno", equals: "sim" } });
      const g = field("g", { condition: { field: "f", equals: "Y" } });
      const fCell = (d: ReturnType<typeof run>) => [cell(d, "f"), pendingOf(d).filter(([, name]) => name === "f")];
      // Resposta legada, sem `answer_field_hashes`: conta como tendo visto todo campo.
      const coded = (id: string, answers: Record<string, unknown>): ExportResponse => ({
        id, document_id: "A", respondent_name: id, respondent_type: "humano", answers,
      });
      const bothModes = (overrides: Partial<AssembleInput>) =>
        [false, true].map((fillFromLlm) => exported({ fields: [interno, f], ...overrides, fillFromLlm }));

      it("veredito no filho: entra igual nos dois modos, sem contradição", () => {
        const verdictOnF = {
          id: "rv-f", document_id: "A", field_name: "f", verdict: "X", comment: null,
          created_at: "2026-01-01T00:00:00Z", field_hash: null, chosen_response_id: null,
        };
        const [off, on] = bothModes({ responses: [human("h1"), llm({ interno: "não" })], reviews: [verdictOnF] });
        expect(fCell(off)).toEqual(["X", []]);
        expect(fCell(on)).toEqual(fCell(off));
        expect(cell(on, "interno")).toBe("não");
      });

      it("consenso de dois pesquisadores no filho: igual nos dois modos, esperando o pai", () => {
        const answers = { interno: "sim", f: "X" };
        const [off, on] = bothModes({ responses: [coded("h1", answers), coded("h2", answers), llm({ interno: "não" })] });
        expect(fCell(off)).toEqual(["", [["A", "f", "aguarda o campo interno"]]]);
        expect(fCell(on)).toEqual(fCell(off));
      });

      it("o branco que a célula do LLM decide também não decide o neto com pesquisador", () => {
        // Nenhum pesquisador vê `f` (a resposta dele não tem `interno`), mas
        // os dois responderam `g`.
        const answers = { f: "Y", g: "Z" };
        const [off, on] = bothModes({ fields: [interno, f, g], responses: [coded("h1", answers), coded("h2", answers), llm({ interno: "não" })] });
        const gCell = (d: ReturnType<typeof run>) => [cell(d, "g"), pendingOf(d).filter(([, name]) => name === "g")];
        expect(gCell(off)).toEqual(["", [["A", "g", "aguarda o campo f"]]]);
        expect(gCell(on)).toEqual(gCell(off));
        // O branco do próprio `f`, que nenhum pesquisador respondeu, a opção muda.
        expect(pendingOf(on).filter(([, name]) => name === "f")).toEqual([]);
      });

      it("pai llm_only fora da condição do avô: o filho com pesquisador espera igual nos dois modos", () => {
        const internoDoPai = field("interno", { target: "llm_only", condition: { field: "pai", equals: "sim" } });
        const answers = { pai: "não", interno: "sim", f: "X" };
        const [off, on] = bothModes({
          fields: [pai, internoDoPai, f], responses: [coded("h1", answers), coded("h2", answers), llm({ pai: "não" })],
        });
        expect(fCell(off)).toEqual(["", [["A", "f", "aguarda o campo interno"]]]);
        expect(fCell(on)).toEqual(fCell(off));
      });

      describe("pai comum que só o LLM preencheu, porque nasceu depois da codificação", () => {
        // `extra` não é `llm_only`: entra em `GabaritoLine.optionOnly` só porque
        // a célula dele saiu de `uncodedCell`. Os pesquisadores codificaram `f`
        // antes de `extra` existir (fora de `answer_field_hashes`); com
        // `exists: false`, `f` fica à mostra para eles, e a linha com o valor
        // do LLM em `extra` diria que `f` não se aplica.
        const fOnExtra = field("f", { condition: { field: "extra", exists: false } });
        const codedBefore = (id: string, answers: Record<string, unknown>): ExportResponse => ({
          id, document_id: "A", respondent_name: id, respondent_type: "humano", answers, answer_field_hashes: { f: "h" },
        });
        const modes = (overrides: Partial<AssembleInput>) => bothModes({ fields: [extra, fOnExtra], ...overrides });

        it("pesquisadores que concordam no filho: igual nos dois modos, esperando o pai", () => {
          const responses = [codedBefore("h1", { f: "X" }), codedBefore("h2", { f: "X" }), llm({ extra: "do LLM" })];
          const [off, on] = modes({ responses });
          expect(cell(on, "extra")).toBe("do LLM");
          expect(fCell(off)).toEqual(["", [["A", "f", "aguarda o campo extra"]]]);
          expect(fCell(on)).toEqual(fCell(off));
        });

        it("veredito no filho: entra igual nos dois modos, sem contradição", () => {
          const verdictOnF = {
            id: "rv-f", document_id: "A", field_name: "f", verdict: "X", comment: null,
            created_at: "2026-01-01T00:00:00Z", field_hash: null, chosen_response_id: null,
          };
          const responses = [codedBefore("h1", { f: "X" }), codedBefore("h2", { f: "Y" }), llm({ extra: "do LLM" })];
          const [off, on] = modes({ responses, reviews: [verdictOnF] });
          expect(cell(on, "extra")).toBe("do LLM");
          expect(fCell(off)).toEqual(["X", []]);
          expect(fCell(on)).toEqual(fCell(off));
        });
      });

      it("filho só do LLM com pai só do LLM: a condição vale na linha", () => {
        const onlyLlm = (answers: Record<string, unknown>) =>
          exported({ fields: [interno, f], fillFromLlm: true, responses: [human("h1"), human("h2"), llm(answers)] });
        const fails = onlyLlm({ interno: "não", f: "Y" });
        expect(cell(fails, "f")).toBe("");
        expect(fails.pending.rows).toEqual([]);
        expect(fails.llmOnly.rows).toEqual([["A", "", "interno"]]);
        const holds = onlyLlm({ interno: "sim", f: "Y" });
        expect(cell(holds, "f")).toBe("Y");
        expect(holds.llmOnly.rows).toEqual([["A", "", "interno"], ["A", "", "f"]]);
      });
    });

    it("ligada: a condição que não se cumpre na linha continua deixando a célula em branco", () => {
      const filho = field("filho", { condition: { field: "pai", equals: "sim" } });
      const d = exported({
        fillFromLlm: true,
        fields: [pai, filho],
        responses: [
          { ...human("h1"), answers: { pai: "não" } },
          { ...human("h2"), answers: { pai: "não" } },
          llm({ pai: "sim", filho: "Sim" }),
        ],
      });
      expect(cell(d, "pai")).toBe("não");
      expect(cell(d, "filho")).toBe("");
      expect(d.pending.rows).toEqual([]);
      expect(d.llmOnly.rows).toEqual([]);
    });
  });

  describe("auto-revisão (view final_answers)", () => {
    const answer = (provenance: ExportFinalAnswer["provenance"], value: unknown = null): ExportFinalAnswer => ({
      document_id: "A", field_name: "campo", provenance, answer: value,
    });
    const responses = [resp("h1", "humano", "Sim"), resp("l", "llm", "Não")];

    it.each(["auto_corrigido", "equivalente", "arbitrado"] as const)("%s resolvida preenche com o valor da view", (provenance) => {
      const d = exported({ responses, finalAnswers: [answer(provenance, "Não")] });
      expect(cellOf(d)).toBe("Não");
      expect(d.pending.rows).toEqual([]);
    });

    it.each([
      ["aguarda_auto_revisao", "auto-revisão pendente"],
      ["aguarda_reconciliacao", "auto-revisão pendente"],
      ["aguarda_arbitragem", "aguarda arbitragem"],
      ["ambiguo", "ambíguo ou pular"],
      ["pergunta_alterada", "pergunta alterada"],
    ] as const)("%s deixa em branco com o motivo da view", (provenance, reason) => {
      const d = exported({ responses, finalAnswers: [answer(provenance)] });
      expect(cellOf(d)).toBe("");
      expect(pendingOf(d)).toEqual([["A", "campo", reason]]);
    });

    it("pesquisadores divergentes entre si: o motivo aponta a Comparação, não o ciclo pendente", () => {
      const d = exported({
        responses: [resp("h1", "humano", "Saúde suplementar"), resp("h2", "humano", "Saúde pública"), resp("l", "llm", "Saúde pública")],
        finalAnswers: [answer("aguarda_auto_revisao")],
      });
      expect(pendingOf(d)).toEqual([["A", "campo", "divergência entre pesquisadores"]]);
    });

    it("auto-revisão resolvida vale acima do consenso das respostas", () => {
      const d = exported({
        responses: [resp("h1", "humano", "Sim"), resp("h2", "humano", "Sim"), resp("l", "llm", "Não")],
        finalAnswers: [answer("arbitrado", "Não")],
      });
      expect(cellOf(d)).toBe("Não");
    });

    it("consenso da view não decide nada: a concordância das respostas é que vale", () => {
      const d = exported({ responses, finalAnswers: [answer("consenso", "Não")] });
      expect(cellOf(d)).toBe("");
    });
  });

  describe("motivos das Pendências", () => {
    it("Em discussão no LLM Insights", () => {
      const d = run({
        fields: [field("x", { hash: "h" })],
        documents: [doc("doc1")],
        responses: [
          { id: "rllm", document_id: "doc1", respondent_name: "LLM", respondent_type: "llm", answers: { x: "LLM" } },
          { id: "rh", document_id: "doc1", respondent_name: "R1", respondent_type: "humano", answers: { x: "Humano" } },
        ],
        reviews: [{ id: "review1", document_id: "doc1", field_name: "x", verdict: "Humano", comment: null,
          created_at: "2026-01-01T00:00:00Z", field_hash: "h", chosen_response_id: "rh" }],
        errorResolutions: [resolutionFixture("discussion")],
      });
      expect(pendingOf(d)).toEqual([["doc1", "x", "em discussão no LLM Insights"]]);
    });

    it("veredito que perdeu a validade vira pergunta alterada", () => {
      const d = exported({
        fields: [field("campo", { hash: "atual" })],
        responses: [resp("h1", "humano", "Sim"), resp("l", "llm", "Não")],
        reviews: [{ id: "rv", document_id: "A", field_name: "campo", verdict: "Sim", comment: null,
          created_at: "2026-01-01T00:00:00Z", field_hash: "antigo", chosen_response_id: null }],
      });
      expect(pendingOf(d)).toEqual([["A", "campo", "pergunta alterada"]]);
    });

    it("um só pesquisador, sem LLM: poucas respostas", () => {
      const d = exported({ responses: [resp("h1", "humano", "Sim")] });
      expect(pendingOf(d)).toEqual([["A", "campo", "poucas respostas"]]);
    });

    it("concordantes abaixo do piso: poucas respostas, mesmo com dois pesquisadores no documento", () => {
      // h2 codificou antes de o campo existir: sobram h1 e o LLM, que concordam.
      const d = exported({
        minResponses: 4,
        responses: [resp("h1", "humano", "Sim"), { ...resp("h2", "humano", undefined), answer_field_hashes: { outro: "h" } }, resp("l", "llm", "Sim")],
      });
      expect(pendingOf(d)).toEqual([["A", "campo", "poucas respostas"]]);
    });

    it("divergentes abaixo do piso, com um pesquisador só: poucas respostas, e não arbitragem", () => {
      const d = exported({
        minResponses: 3,
        responses: [resp("h1", "humano", "Sim"), resp("l", "llm", "Não")],
      });
      expect(pendingOf(d)).toEqual([["A", "campo", "poucas respostas"]]);
    });

    it("divergentes abaixo do piso, com dois pesquisadores no documento: aguarda arbitragem, e não poucas respostas", () => {
      // h2 codificou antes de o campo existir e não conta: sobram h1 e o LLM,
      // que divergem. O documento fica abaixo do piso, mas tem dois
      // pesquisadores, e o piso sozinho não basta para dizer "poucas respostas".
      const d = exported({
        minResponses: 4,
        responses: [resp("h1", "humano", "Sim"), { ...resp("h2", "humano", undefined), answer_field_hashes: { outro: "h" } }, resp("l", "llm", "Não")],
      });
      expect(pendingOf(d)).toEqual([["A", "campo", "aguarda arbitragem"]]);
    });

    it("divergência que a Comparação não examina: o motivo diz que o campo não entra nela", () => {
      const d = exported({
        fields: [field("campo", { target: "human_only" })],
        responses: [resp("h1", "humano", "Sim"), resp("h2", "humano", "Não")],
      });
      expect(pendingOf(d)).toEqual([["A", "campo", "respostas divergem e o campo não entra na Comparação"]]);
    });

    it("documento só com a resposta do LLM não entra nas Pendências", () => {
      const d = exported({ responses: [resp("l", "llm", "Sim")] });
      expect(d.pending.rows).toEqual([]);
    });
  });
});
