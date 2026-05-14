import { describe, it, expect } from "vitest";
import { normalizeForComparison, normalizeText } from "@/lib/utils";

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
