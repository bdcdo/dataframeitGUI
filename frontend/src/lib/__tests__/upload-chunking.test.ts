import { describe, it, expect, vi } from "vitest";
import {
  MAX_CHUNK_BYTES,
  MAX_DOCS_PER_CHUNK,
  chunkByBytes,
  isPayloadTooLarge,
  mapWithConcurrency,
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
