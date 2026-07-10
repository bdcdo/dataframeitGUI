import { describe, it, expect, vi } from "vitest";
import Papa from "papaparse";
import {
  MAX_CHUNK_BYTES,
  MAX_DOCS_PER_CHUNK,
  PAYLOAD_TOO_LARGE_MESSAGE,
  buildDocs,
  buildUploadErrorMessage,
  buildUploadSuccessMessage,
  chunkByBytes,
  docBytes,
  isPayloadTooLarge,
  mapWithConcurrency,
  remapDuplicateMapToChunk,
  utf8Bytes,
} from "@/lib/upload-chunking";

const doc = (text: string) => ({ text });

describe("utf8Bytes", () => {
  it("conta bytes ascii, multibyte e vazio", () => {
    expect(utf8Bytes("")).toBe(0);
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2); // U+00E9 → 2 bytes em UTF-8
    expect(utf8Bytes("😀")).toBe(4); // emoji → 4 bytes
  });
});

describe("isPayloadTooLarge", () => {
  it("reconhece os três gatilhos de payload grande", () => {
    expect(isPayloadTooLarge("Body exceeded the limit")).toBe(true);
    expect(isPayloadTooLarge("Request failed with status 413")).toBe(true);
    expect(isPayloadTooLarge("FUNCTION_PAYLOAD_TOO_LARGE")).toBe(true);
  });

  it("é falso para mensagem vazia ou não relacionada", () => {
    expect(isPayloadTooLarge("")).toBe(false);
    expect(isPayloadTooLarge("Erro de rede genérico")).toBe(false);
  });
});

describe("chunkByBytes", () => {
  it("retorna vazio para lista vazia", () => {
    expect(chunkByBytes([])).toEqual([]);
  });

  it("emite um único chunk para um doc", () => {
    const chunks = chunkByBytes([doc("oi")]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startIndex).toBe(0);
    expect(chunks[0].items).toHaveLength(1);
  });

  it("divide por bytes e propaga startIndex como contagem acumulada", () => {
    // 5 docs de ~1 MB: 3 cabem em ~3 MB (< 3,5 MB), o 4º estoura o orçamento.
    const oneMb = "a".repeat(1_000_000);
    const chunks = chunkByBytes(Array.from({ length: 5 }, () => doc(oneMb)));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].items).toHaveLength(3);
    expect(chunks[0].startIndex).toBe(0);
    expect(chunks[1].items).toHaveLength(2);
    // startIndex do 2º chunk = nº de itens já consumidos (alimenta a
    // relocalização de csvIndex no doUpload). Off-by-one aqui = dano a dados.
    expect(chunks[1].startIndex).toBe(3);
  });

  it("divide pelo teto de contagem (MAX_DOCS_PER_CHUNK)", () => {
    const docs = Array.from({ length: MAX_DOCS_PER_CHUNK + 1 }, () => doc("x"));
    const chunks = chunkByBytes(docs);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].items).toHaveLength(MAX_DOCS_PER_CHUNK);
    expect(chunks[0].startIndex).toBe(0);
    expect(chunks[1].items).toHaveLength(1);
    expect(chunks[1].startIndex).toBe(MAX_DOCS_PER_CHUNK);
  });

  it("emite um doc acima do orçamento sozinho no próprio chunk", () => {
    const oversize = "a".repeat(MAX_CHUNK_BYTES + 1);
    const chunks = chunkByBytes([doc(oversize), doc("pequeno")]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].items).toHaveLength(1);
    expect(chunks[0].startIndex).toBe(0);
    expect(chunks[1].items).toHaveLength(1);
    expect(chunks[1].startIndex).toBe(1);
  });

  it("mede o doc serializado completo: metadata empurra para além do orçamento", () => {
    // Cada doc: ~1 MB de texto + a MESMA ~1 MB repetida em metadata.original_row
    // (a coluna de texto também é preservada — FR-002). Só pelo `text`, os dois
    // caberiam num chunk (2 MB < 3,5 MB); medindo o doc serializado, cada um pesa
    // ~2 MB e os dois estouram o orçamento → 2 chunks. Guarda contra medir só o texto.
    const oneMb = "a".repeat(1_000_000);
    const docs = buildDocs(
      { rows: [{ texto: oneMb }, { texto: oneMb }], columns: ["texto"] },
      { text: "texto", title: "", external_id: "" }
    );
    // Sanidade: só pelo texto, os dois caberiam num único chunk.
    expect(utf8Bytes(docs[0].text) + utf8Bytes(docs[1].text)).toBeLessThan(
      MAX_CHUNK_BYTES
    );

    const chunks = chunkByBytes(docs);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].items).toHaveLength(1);
    expect(chunks[1].items).toHaveLength(1);
  });
});

describe("docBytes", () => {
  it("mede o doc serializado completo, não apenas o texto", () => {
    const [built] = buildDocs(
      { rows: [{ texto: "abc", extra: "xyz" }], columns: ["texto", "extra"] },
      { text: "texto", title: "", external_id: "" }
    );
    // metadata carrega 'texto' e 'extra' de novo → serializado > só o texto.
    expect(docBytes(built)).toBeGreaterThan(utf8Bytes(built.text));
  });
});

describe("mapWithConcurrency", () => {
  it("retorna vazio para lista vazia sem chamar fn", async () => {
    const fn = vi.fn(async (x: number) => x);
    expect(await mapWithConcurrency([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("preserva a ordem dos resultados mesmo quando as chamadas resolvem fora de ordem", async () => {
    // delays decrescentes: item 0 resolve por último, item 3 primeiro.
    const out = await mapWithConcurrency([30, 20, 10, 0], 4, (ms, i) =>
      new Promise<string>((r) => setTimeout(() => r(`#${i}`), ms))
    );
    expect(out).toEqual(["#0", "#1", "#2", "#3"]);
  });

  it("nunca mantém mais que `limit` chamadas em voo ao mesmo tempo", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return x;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("processa todos os itens quando há mais itens que o limite", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 6, async (x) => x * 2);
    expect(out).toEqual(items.map((x) => x * 2));
  });
});

describe("buildDocs", () => {
  const mapping = { text: "texto", title: "titulo", external_id: "ext" };

  it("retorna vazio sem csv ou sem coluna de texto mapeada", () => {
    expect(buildDocs(null, mapping)).toEqual([]);
    expect(
      buildDocs({ rows: [{ texto: "a" }], columns: ["texto"] }, { ...mapping, text: "" })
    ).toEqual([]);
  });

  it("filtra linhas com texto vazio e mapeia title/external_id opcionais", () => {
    const csv = {
      rows: [
        { texto: "conteúdo 1", titulo: "Doc 1", ext: "e1" },
        { texto: "   ", titulo: "Doc vazio", ext: "e2" },
        { texto: "conteúdo 3", titulo: "", ext: "" },
      ],
      columns: ["texto", "titulo", "ext"],
    };

    const docs = buildDocs(csv, mapping);

    expect(docs).toEqual([
      {
        text: "conteúdo 1",
        title: "Doc 1",
        external_id: "e1",
        metadata: {
          original_row: { texto: "conteúdo 1", titulo: "Doc 1", ext: "e1" },
          original_columns: ["texto", "titulo", "ext"],
          text_column: "texto",
        },
      },
      {
        text: "conteúdo 3",
        title: "",
        external_id: "",
        metadata: {
          original_row: { texto: "conteúdo 3", titulo: "", ext: "" },
          original_columns: ["texto", "titulo", "ext"],
          text_column: "texto",
        },
      },
    ]);
  });

  it("não mapeia title/external_id quando a coluna não foi selecionada", () => {
    const csv = { rows: [{ texto: "conteúdo" }], columns: ["texto"] };
    const docs = buildDocs(csv, { text: "texto", title: "", external_id: "" });
    expect(docs).toEqual([
      {
        text: "conteúdo",
        title: undefined,
        external_id: undefined,
        metadata: {
          original_row: { texto: "conteúdo" },
          original_columns: ["texto"],
          text_column: "texto",
        },
      },
    ]);
  });

  it("preserva colunas não mapeadas na linha original (inclusive as mapeadas)", () => {
    const csv = {
      rows: [
        {
          id_original: "0001",
          titulo: "Apelação",
          texto: "Inteiro teor",
          tribunal: "TJSP",
          classe: "",
        },
      ],
      columns: ["id_original", "titulo", "texto", "tribunal", "classe"],
    };

    const [d] = buildDocs(csv, {
      text: "texto",
      title: "titulo",
      external_id: "id_original",
    });

    // original_row inclui as colunas mapeadas (texto/titulo/id_original) E as
    // não mapeadas (tribunal/classe); célula vazia preservada como "".
    expect(d.metadata).toEqual({
      original_row: {
        id_original: "0001",
        titulo: "Apelação",
        texto: "Inteiro teor",
        tribunal: "TJSP",
        classe: "",
      },
      original_columns: ["id_original", "titulo", "texto", "tribunal", "classe"],
      text_column: "texto",
    });
  });

  it("normaliza célula ausente (linha curta) para '' mantendo a coluna", () => {
    // A linha não tem a chave 'classe'; original_row ainda registra classe: "".
    const csv = {
      rows: [{ texto: "conteúdo", tribunal: "TJRS" }],
      columns: ["texto", "tribunal", "classe"],
    };
    const [d] = buildDocs(csv, { text: "texto", title: "", external_id: "" });
    expect(d.metadata?.original_row).toEqual({
      texto: "conteúdo",
      tribunal: "TJRS",
      classe: "",
    });
    expect(d.metadata?.original_columns).toEqual(["texto", "tribunal", "classe"]);
  });

  // Regressão da garantia de cabeçalhos únicos (achado C2): buildDocs confia que
  // o papaparse (header: true) renomeia colunas homônimas preservando os valores,
  // e NÃO re-normaliza. Este teste protege essa dependência contra bumps do pacote.
  it("papaparse renomeia colunas homônimas e buildDocs preserva todos os valores", () => {
    const csvText = "nome,texto,nome\nAna,conteúdo,Silva";
    const parsed = Papa.parse<Record<string, string>>(csvText, { header: true });
    const columns = parsed.meta.fields ?? [];

    // papaparse 5.5.4: a duplicata 'nome' vira 'nome_1' ("Duplicate headers ... renamed").
    expect(columns).toEqual(["nome", "texto", "nome_1"]);

    const [d] = buildDocs(
      { rows: parsed.data, columns },
      { text: "texto", title: "", external_id: "" }
    );
    expect(d.metadata?.original_columns).toEqual(["nome", "texto", "nome_1"]);
    expect(d.metadata?.original_row).toEqual({
      nome: "Ana",
      texto: "conteúdo",
      nome_1: "Silva",
    });
  });
});

describe("remapDuplicateMapToChunk", () => {
  it("retorna undefined quando options é undefined", () => {
    expect(remapDuplicateMapToChunk(undefined, 0, 10)).toBeUndefined();
  });

  it("filtra e relocaliza csvIndex para o intervalo do chunk", () => {
    const options = {
      mode: "add_new_only" as const,
      duplicateMap: [
        { csvIndex: 2, existingDocId: "d1", matchType: "text_hash" as const },
        { csvIndex: 7, existingDocId: "d2", matchType: "text_hash" as const },
        { csvIndex: 12, existingDocId: "d3", matchType: "text_hash" as const },
      ],
    };

    const result = remapDuplicateMapToChunk(options, 5, 10);

    expect(result?.mode).toBe("add_new_only");
    expect(result?.duplicateMap).toEqual([
      { csvIndex: 2, existingDocId: "d2", matchType: "text_hash" },
    ]);
  });

  it("preserva deleteResponses", () => {
    const options = { mode: "replace_and_add" as const, deleteResponses: true };
    expect(remapDuplicateMapToChunk(options, 0, 5)?.deleteResponses).toBe(true);
  });
});

describe("buildUploadSuccessMessage", () => {
  it("sem docs ignorados, mensagem simples de importados", () => {
    expect(buildUploadSuccessMessage(10, 10, "add_all")).toBe(
      "10 documentos importados!"
    );
  });

  it("com docs ignorados, mensagem detalhada", () => {
    expect(buildUploadSuccessMessage(7, 10, "add_new_only")).toBe(
      "7 documento(s) importado(s); 3 ignorado(s) (já existiam no projeto ou repetidos no arquivo)."
    );
  });

  it("modo replace_and_add usa o verbo importados/atualizados", () => {
    expect(buildUploadSuccessMessage(10, 10, "replace_and_add")).toBe(
      "10 documentos importados/atualizados!"
    );
  });
});

describe("buildUploadErrorMessage", () => {
  it("payload too large sem nenhum doc inserido", () => {
    const msg = buildUploadErrorMessage({
      totalInserted: 0,
      totalDocs: 10,
      mode: "add_all",
      deleteResponses: undefined,
      msg: "FUNCTION_PAYLOAD_TOO_LARGE",
    });
    expect(msg).toBe(PAYLOAD_TOO_LARGE_MESSAGE);
  });

  it("falha parcial reporta quantos foram importados antes do erro", () => {
    const msg = buildUploadErrorMessage({
      totalInserted: 4,
      totalDocs: 10,
      mode: "add_all",
      deleteResponses: undefined,
      msg: "erro de rede",
    });
    expect(msg).toBe("4 de 10 documentos importados antes de uma falha: erro de rede");
  });

  it("replace destrutivo sem nenhum doc inserido avisa sobre possível remoção", () => {
    const msg = buildUploadErrorMessage({
      totalInserted: 0,
      totalDocs: 10,
      mode: "replace_and_add",
      deleteResponses: true,
      msg: "erro qualquer",
    });
    expect(msg).toBe(
      "A importação falhou, mas respostas/revisões dos documentos duplicados podem já ter sido removidas. Confira a lista. (erro qualquer)"
    );
  });

  it("replace destrutivo com docs inseridos anexa o aviso de remoção à mensagem de falha parcial", () => {
    const msg = buildUploadErrorMessage({
      totalInserted: 3,
      totalDocs: 10,
      mode: "replace_and_add",
      deleteResponses: true,
      msg: "erro de rede",
    });
    expect(msg).toContain("3 de 10 documentos importados/atualizados antes de uma falha");
    expect(msg).toContain(
      "Respostas/revisões de documentos duplicados podem já ter sido removidas"
    );
  });

  it("erro genérico sem docs inseridos usa a mensagem crua ou o fallback", () => {
    expect(
      buildUploadErrorMessage({
        totalInserted: 0,
        totalDocs: 10,
        mode: "add_all",
        deleteResponses: undefined,
        msg: "algo deu errado",
      })
    ).toBe("algo deu errado");
    expect(
      buildUploadErrorMessage({
        totalInserted: 0,
        totalDocs: 10,
        mode: "add_all",
        deleteResponses: undefined,
        msg: "",
      })
    ).toBe("Erro ao importar documentos");
  });
});
