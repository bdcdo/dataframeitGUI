import { describe, it, expect } from "vitest";
import { formatAnswer, formatVerdictDisplay } from "@/lib/reviews/verdict-format";

describe("formatAnswer", () => {
  it("trata null/undefined como '(sem resposta)'", () => {
    expect(formatAnswer(null)).toBe("(sem resposta)");
    expect(formatAnswer(undefined)).toBe("(sem resposta)");
  });

  it("retorna strings cruas e converte primitivos", () => {
    expect(formatAnswer("sim")).toBe("sim");
    expect(formatAnswer(42)).toBe("42");
    expect(formatAnswer(true)).toBe("true");
  });

  it("junta arrays com ', '", () => {
    expect(formatAnswer(["a", "b", "c"])).toBe("a, b, c");
  });

  it("serializa objeto como 'k: v' separado por ', ', omitindo vazios", () => {
    expect(formatAnswer({ a: "1", b: "", c: "3" })).toBe("a: 1, c: 3");
  });
});

describe("formatVerdictDisplay", () => {
  it("rotula vereditos especiais", () => {
    expect(formatVerdictDisplay("ambiguo")).toBe("Ambíguo");
    expect(formatVerdictDisplay("pular")).toBe("Pular");
  });

  it("expande seleções multi a partir de JSON", () => {
    expect(formatVerdictDisplay('{"x":true,"y":false,"z":true}', "multi")).toBe(
      "x; z",
    );
  });

  it("retorna '(nenhuma)' quando nenhuma opção multi está marcada", () => {
    expect(formatVerdictDisplay('{"x":false}', "multi")).toBe("(nenhuma)");
  });

  it("faz fallback para o texto cru quando o JSON é inválido", () => {
    expect(formatVerdictDisplay("sim", "text")).toBe("sim");
    expect(formatVerdictDisplay("{quebrado", "multi")).toBe("{quebrado");
  });
});
