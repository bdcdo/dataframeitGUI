import { describe, it, expect } from "vitest";
import { isAutoReviewFieldDecided } from "@/lib/auto-review-decided";

describe("isAutoReviewFieldDecided", () => {
  it("alreadyAnswered → decidido independente de choice/justificativa", () => {
    expect(isAutoReviewFieldDecided(true, null, undefined)).toBe(true);
    expect(isAutoReviewFieldDecided(true, "contesta_llm", undefined)).toBe(true);
  });

  it("sem escolha → não decidido", () => {
    expect(isAutoReviewFieldDecided(false, null, undefined)).toBe(false);
    expect(isAutoReviewFieldDecided(false, undefined, undefined)).toBe(false);
  });

  it("admite_erro → decidido sem precisar de justificativa", () => {
    expect(isAutoReviewFieldDecided(false, "admite_erro", undefined)).toBe(true);
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
