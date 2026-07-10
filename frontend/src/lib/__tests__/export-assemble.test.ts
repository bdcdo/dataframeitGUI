import { describe, it, expect } from "vitest";
import {
  assembleExport,
  resolveOriginalHeaders,
  type AssembleInput,
  type ExportDocument,
  type ExportSheet,
} from "@/lib/export/assemble";
import type { PydanticField } from "@/lib/types";

// --- Fixtures helpers ---

function field(name: string, opts: Partial<PydanticField> = {}): PydanticField {
  return { name, type: "text", options: null, description: "", ...opts };
}

function doc(
  id: string,
  opts: {
    external_id?: string | null;
    title?: string | null;
    created_at?: string;
    columns?: string[];
    row?: Record<string, string>;
  } = {}
): ExportDocument {
  const {
    external_id = null,
    title = null,
    created_at = "2024-01-01T00:00:00Z",
    columns,
    row,
  } = opts;
  const metadata =
    columns === undefined
      ? null
      : {
          original_columns: columns,
          original_row: row ?? Object.fromEntries(columns.map((c) => [c, ""])),
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
        { document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { campo: "sim" } },
        { document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { campo: "sim" } },
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
        { document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { campo: "sim" } },
        { document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { campo: "nao" } },
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
        { document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { campo: "sim" } },
      ],
    });
    expect(d.verdicts.rows).toHaveLength(0);
  });

  it("campo multi concorda por conjuntos de opções", () => {
    const d = run({
      fields: [field("opts", { type: "multi", options: ["x", "y"] })],
      documents: [doc("A")],
      responses: [
        { document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { opts: ["x"] } },
        { document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { opts: ["x"] } },
      ],
    });
    expect(d.verdicts.rows[0][idx(d.verdicts, "opts")]).toBe("x");
  });

  it("campo multi diverge quando os conjuntos diferem", () => {
    const d = run({
      fields: [field("opts", { type: "multi", options: ["x", "y"] })],
      documents: [doc("A")],
      responses: [
        { document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { opts: ["x"] } },
        { document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { opts: ["y"] } },
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
        { document_id: "A", respondent_name: "R1", respondent_type: "codificacao", answers: { campo: "concordado" } },
        { document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { campo: "concordado" } },
      ],
      reviews: [
        { document_id: "A", field_name: "campo", verdict: "pular", comment: "nota do revisor" },
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
        { document_id: "A", respondent_name: "R1", respondent_type: "llm", answers: { campo: "v" } },
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
        { document_id: "A", respondent_name: "R1", respondent_type: "llm", answers: { campo: "a" } },
        { document_id: "A", respondent_name: "R2", respondent_type: "codificacao", answers: { campo: "b" } },
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
        { document_id: "A", respondent_name: "R1", respondent_type: "llm", answers: { campo: "v" } },
        { document_id: "ghost", respondent_name: "RX", respondent_type: "llm", answers: { campo: "x" } },
      ],
      reviews: [
        { document_id: "ghost", field_name: "campo", verdict: "ambiguo", comment: null },
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
