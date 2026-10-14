import { describe, it, expect } from "vitest";
import {
  COMPARE_SPLIT_COOKIE,
  MIN_PANEL_PERCENT,
  READER_PANEL_ID,
  REVIEW_PANEL_ID,
  parseLegacySplitLayout,
  parseSplitLayout,
  readSplitCookie,
  sameSplit,
  splitLayoutCookie,
} from "../compare-split-layout";

const layout = (reader: unknown, review: unknown) =>
  JSON.stringify({ [READER_PANEL_ID]: reader, [REVIEW_PANEL_ID]: review });

describe("parseSplitLayout", () => {
  it("aceita o layout que a lib entrega, decodificado ou em percent-encoding", () => {
    const raw = layout(30.42, 69.58);
    const expected = { [READER_PANEL_ID]: 30.42, [REVIEW_PANEL_ID]: 69.58 };
    expect(parseSplitLayout(raw)).toEqual(expected);
    expect(parseSplitLayout(encodeURIComponent(raw))).toEqual(expected);
  });

  it("descarta chaves estranhas em vez de repassá-las à lib", () => {
    const raw = JSON.stringify({
      [READER_PANEL_ID]: 40,
      [REVIEW_PANEL_ID]: 60,
      outro: 10,
    });
    expect(parseSplitLayout(raw)).toEqual({
      [READER_PANEL_ID]: 40,
      [REVIEW_PANEL_ID]: 60,
    });
  });

  it.each([
    ["ausente", undefined],
    ["vazio", ""],
    ["JSON quebrado", "{"],
    ["percent-encoding quebrado", "%E0%A4%A"],
    ["não objeto", "50"],
    ["null", "null"],
    ["falta um painel", JSON.stringify({ [READER_PANEL_ID]: 100 })],
    ["número como string", layout("50", 50)],
    ["negativo", layout(-10, 110)],
    ["acima de 100", layout(101, -1)],
    ["soma longe de 100", layout(60, 60)],
    // A lib ajustaria na montagem, e o HTML do servidor divergiria dela.
    ["abaixo do mínimo", layout(20, 80)],
    ["painel zerado", layout(0, 100)],
  ])("recusa layout inválido: %s", (_caso, raw) => {
    expect(parseSplitLayout(raw)).toBeNull();
  });

  it("tolera o arredondamento da lib na soma", () => {
    expect(parseSplitLayout(layout(33.333, 66.666))).not.toBeNull();
  });

  it("aceita o próprio mínimo, que é onde a lib para o divisor", () => {
    const min = MIN_PANEL_PERCENT;
    expect(parseSplitLayout(layout(min, 100 - min))).not.toBeNull();
    expect(parseSplitLayout(layout(min - 0.005, 100 - min + 0.005))).not.toBeNull();
  });
});

describe("parseLegacySplitLayout", () => {
  it("aceita divisão antiga abaixo do mínimo, para a lib ajustar", () => {
    // Antes o mínimo efetivo era 25px, e 15% era uma divisão possível.
    expect(parseLegacySplitLayout(layout(15, 85))).toEqual({
      [READER_PANEL_ID]: 15,
      [REVIEW_PANEL_ID]: 85,
    });
    expect(parseSplitLayout(layout(15, 85))).toBeNull();
  });

  it("continua recusando o que não é divisão", () => {
    expect(parseLegacySplitLayout(layout(60, 60))).toBeNull();
    expect(parseLegacySplitLayout(layout(-5, 105))).toBeNull();
    expect(parseLegacySplitLayout("{")).toBeNull();
  });
});

describe("splitLayoutCookie", () => {
  it("grava um valor que parseSplitLayout lê de volta", () => {
    const value = { [READER_PANEL_ID]: 25, [REVIEW_PANEL_ID]: 75 };
    const line = splitLayoutCookie(value);
    expect(line.startsWith(`${COMPARE_SPLIT_COOKIE}=`)).toBe(true);
    // `;` e `,` no valor quebrariam o cookie: o JSON vai em percent-encoding.
    const cookieValue = line.slice(COMPARE_SPLIT_COOKIE.length + 1).split(";")[0];
    expect(cookieValue).not.toMatch(/[;,\s"]/);
    expect(parseSplitLayout(cookieValue)).toEqual(value);
    expect(line).toContain("path=/");
  });
});

describe("readSplitCookie", () => {
  it("acha o cookie da divisão entre outros, com ou sem espaço", () => {
    const value = encodeURIComponent(layout(30, 70));
    expect(
      readSplitCookie(`__session=abc; ${COMPARE_SPLIT_COOKIE}=${value};outro=1`),
    ).toBe(value);
  });

  it("não confunde cookie de nome parecido nem cabeçalho vazio", () => {
    expect(readSplitCookie(`${COMPARE_SPLIT_COOKIE}-x=1; x${COMPARE_SPLIT_COOKIE}=2`)).toBeNull();
    expect(readSplitCookie("")).toBeNull();
  });
});

describe("sameSplit", () => {
  const a = { [READER_PANEL_ID]: 30.42, [REVIEW_PANEL_ID]: 69.58 };

  it("ignora diferença de arredondamento e acusa divisão diferente", () => {
    expect(sameSplit(a, { [READER_PANEL_ID]: 30.421, [REVIEW_PANEL_ID]: 69.579 })).toBe(true);
    expect(sameSplit(a, { [READER_PANEL_ID]: 50, [REVIEW_PANEL_ID]: 50 })).toBe(false);
  });

  it("sem divisão de referência, não é a mesma", () => {
    expect(sameSplit(a, null)).toBe(false);
  });
});
