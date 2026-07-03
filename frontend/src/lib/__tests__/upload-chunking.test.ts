import { describe, it, expect, vi } from "vitest";
import {
  MAX_CHUNK_BYTES,
  MAX_DOCS_PER_CHUNK,
  PAYLOAD_TOO_LARGE_MESSAGE,
  buildDocs,
  buildUploadErrorMessage,
  buildUploadSuccessMessage,
  chunkByBytes,
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
      { text: "conteúdo 1", title: "Doc 1", external_id: "e1" },
      { text: "conteúdo 3", title: "", external_id: "" },
    ]);
  });

  it("não mapeia title/external_id quando a coluna não foi selecionada", () => {
    const csv = { rows: [{ texto: "conteúdo" }], columns: ["texto"] };
    const docs = buildDocs(csv, { text: "texto", title: "", external_id: "" });
    expect(docs).toEqual([{ text: "conteúdo", title: undefined, external_id: undefined }]);
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
