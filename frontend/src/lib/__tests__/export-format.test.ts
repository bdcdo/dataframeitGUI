import { describe, it, expect } from "vitest";
import { formatExportValue, formatVerdict } from "@/lib/export/format";

// Comportamento idêntico ao que vivia inline em reviews/export/page.tsx antes da
// feature 004 (formatExportValue + formatação de veredicto), agora extraído para
// funções puras testáveis.

describe("formatExportValue", () => {
  it("null e undefined viram string vazia", () => {
    expect(formatExportValue(null)).toBe("");
    expect(formatExportValue(undefined)).toBe("");
  });

  it("string passa direto", () => {
    expect(formatExportValue("oi")).toBe("oi");
  });

  it("array junta com '; '", () => {
    expect(formatExportValue(["a", "b", "c"])).toBe("a; b; c");
  });

  it("objeto vira 'k: v' filtrando entradas vazias/nulas", () => {
    expect(formatExportValue({ a: "1", b: "", c: null, d: "2" })).toBe(
      "a: 1; d: 2"
    );
  });

  it("número e boolean caem no fallback String()", () => {
    expect(formatExportValue(42)).toBe("42");
    expect(formatExportValue(true)).toBe("true");
  });
});

describe("formatVerdict", () => {
  it("ambiguo → [AMBIGUO]", () => {
    expect(formatVerdict("ambiguo")).toBe("[AMBIGUO]");
  });

  it("pular → [PULAR]", () => {
    expect(formatVerdict("pular")).toBe("[PULAR]");
  });

  it("veredicto multi (JSON) → opções selecionadas juntas com '; '", () => {
    expect(formatVerdict('{"x":true,"y":false,"z":true}')).toBe("x; z");
  });

  it("JSON malformado mantém o valor cru", () => {
    expect(formatVerdict("{quebrado")).toBe("{quebrado");
  });

  it("string comum passa direto", () => {
    expect(formatVerdict("sim")).toBe("sim");
  });
});
