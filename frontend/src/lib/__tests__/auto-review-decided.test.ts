import { describe, it, expect } from "vitest";
import {
  isAutoReviewFieldDecided,
  verdictRequiresJustification,
} from "@/lib/auto-review-decided";

describe("isAutoReviewFieldDecided", () => {
  it("alreadyAnswered → decidido independente de choice/justificativa", () => {
    expect(isAutoReviewFieldDecided(true, null, undefined)).toBe(true);
    expect(isAutoReviewFieldDecided(true, "contesta_llm", undefined)).toBe(true);
  });

  it("sem escolha → não decidido", () => {
    expect(isAutoReviewFieldDecided(false, null, undefined)).toBe(false);
    expect(isAutoReviewFieldDecided(false, undefined, undefined)).toBe(false);
  });

  it("admite_erro e equivalente → decididos sem precisar de justificativa", () => {
    expect(isAutoReviewFieldDecided(false, "admite_erro", undefined)).toBe(true);
    expect(isAutoReviewFieldDecided(false, "equivalente", undefined)).toBe(true);
  });

  it("ambiguo sem justificativa → não decidido", () => {
    expect(isAutoReviewFieldDecided(false, "ambiguo", undefined)).toBe(false);
    expect(isAutoReviewFieldDecided(false, "ambiguo", "   ")).toBe(false);
  });

  it("ambiguo com justificativa preenchida → decidido", () => {
    expect(isAutoReviewFieldDecided(false, "ambiguo", "campo ambíguo")).toBe(
      true,
    );
  });

  it("contesta_llm sem justificativa → não decidido", () => {
    expect(isAutoReviewFieldDecided(false, "contesta_llm", undefined)).toBe(
      false,
    );
    expect(isAutoReviewFieldDecided(false, "contesta_llm", "")).toBe(false);
  });

  it("contesta_llm com justificativa só de espaços → não decidido", () => {
    expect(isAutoReviewFieldDecided(false, "contesta_llm", "   ")).toBe(false);
    expect(isAutoReviewFieldDecided(false, "contesta_llm", "\n\t ")).toBe(false);
  });

  it("contesta_llm com justificativa preenchida → decidido", () => {
    expect(
      isAutoReviewFieldDecided(false, "contesta_llm", "minha resposta confere"),
    ).toBe(true);
    expect(isAutoReviewFieldDecided(false, "contesta_llm", "  ok  ")).toBe(true);
  });
});

describe("verdictRequiresJustification", () => {
  it("contesta_llm e ambiguo exigem justificativa", () => {
    expect(verdictRequiresJustification("contesta_llm")).toBe(true);
    expect(verdictRequiresJustification("ambiguo")).toBe(true);
  });

  it("admite_erro, equivalente e nulo não exigem justificativa", () => {
    expect(verdictRequiresJustification("admite_erro")).toBe(false);
    expect(verdictRequiresJustification("equivalente")).toBe(false);
    expect(verdictRequiresJustification(null)).toBe(false);
    expect(verdictRequiresJustification(undefined)).toBe(false);
  });
});
