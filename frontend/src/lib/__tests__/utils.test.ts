import { describe, it, expect, vi, afterEach } from "vitest";
import { makeId, normalizeForComparison, normalizeText } from "@/lib/utils";

// `crypto.randomUUID` só existe em secure context. Num dev server alcançado por
// IP de LAN em http puro ele é `undefined`, e chamá-lo direto lança — foi assim
// que o token do rascunho de schema derrubava o editor na primeira tecla, num
// segmento sem `error.tsx`. As duas cópias anteriores do helper já traziam a
// guarda; a terceira não, e é por isso que ela virou uma só.
describe("makeId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("usa randomUUID quando o contexto é seguro", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "uuid-do-contexto-seguro" });
    expect(makeId("draft")).toBe("uuid-do-contexto-seguro");
  });

  it("cai no fallback prefixado quando randomUUID não existe", () => {
    vi.stubGlobal("crypto", {});
    const id = makeId("draft");
    expect(id).toMatch(/^draft-[a-z0-9]+$/);
    expect(makeId("draft")).not.toBe(id);
  });

  it("não lança quando crypto inteiro está ausente", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => makeId("lid")).not.toThrow();
  });
});

describe("normalizeText", () => {
  it("remove acentos (diacriticos)", () => {
    expect(normalizeText("Adalimumabé")).toBe("adalimumabe");
  });

  it("trata NFD e NFC como iguais", () => {
    const nfc = "ação".normalize("NFC");
    const nfd = "ação".normalize("NFD");
    expect(nfc).not.toBe(nfd); // bytes diferentes na entrada
    expect(normalizeText(nfc)).toBe(normalizeText(nfd));
  });

  it("é case-insensitive", () => {
    expect(normalizeText("ADALIMUMABE")).toBe(normalizeText("adalimumabe"));
  });

  it("colapsa espacos internos e apara as bordas", () => {
    expect(normalizeText("  acido   acetilsalicilico  ")).toBe(
      "acido acetilsalicilico",
    );
  });
});

describe("normalizeForComparison", () => {
  it("considera iguais strings que diferem só por acento/caixa/espaco", () => {
    expect(normalizeForComparison("Adalimumabe")).toBe(
      normalizeForComparison("  adalimumabé "),
    );
  });

  it("considera iguais NFD vs NFC", () => {
    expect(normalizeForComparison("Imunoglobulina".normalize("NFD"))).toBe(
      normalizeForComparison("Imunoglobulina".normalize("NFC")),
    );
  });

  it("mantem distintas strings semanticamente diferentes", () => {
    expect(normalizeForComparison("Adalimumabe")).not.toBe(
      normalizeForComparison("Infliximabe"),
    );
  });

  it("normaliza elementos string de arrays", () => {
    expect(normalizeForComparison(["Adalimumabe", "Infliximabé"])).toBe(
      normalizeForComparison(["  adalimumabé", "INFLIXIMABE "]),
    );
  });

  it("trata null/number sem quebrar", () => {
    expect(normalizeForComparison(null)).toBe(JSON.stringify(null));
    expect(normalizeForComparison(42)).toBe(JSON.stringify(42));
  });
});
