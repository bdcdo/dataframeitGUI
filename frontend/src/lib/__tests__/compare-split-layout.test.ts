import { describe, it, expect } from "vitest";
import {
  COMPARE_SPLIT_COOKIE,
  READER_PANEL_ID,
  REVIEW_PANEL_ID,
  parseSplitLayout,
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
  ])("recusa layout inválido: %s", (_caso, raw) => {
    expect(parseSplitLayout(raw)).toBeNull();
  });

  it("tolera o arredondamento da lib na soma", () => {
    expect(parseSplitLayout(layout(33.333, 66.666))).not.toBeNull();
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
