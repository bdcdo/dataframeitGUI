import { describe, it, expect } from "vitest";
import { computeAnalyzeTabVisibility } from "@/lib/analyze-tabs";

const base = {
  isCoordinator: false,
  hasPendingAutoReview: false,
  hasArbitragemAssignment: false,
  hasComparacaoAssignment: false,
};

describe("computeAnalyzeTabVisibility — coordenador segue o modo", () => {
  it("auto_review_llm → Auto-revisão + Arbitragem; Comparar oculta", () => {
    const v = computeAnalyzeTabVisibility({
      ...base,
      mode: "auto_review_llm",
      isCoordinator: true,
    });
    expect(v).toEqual({
      showAutoReview: true,
      showArbitragem: true,
      showCompare: false,
    });
  });

  it("compare_humans → Comparar; Auto-revisão/Arbitragem ocultas", () => {
    const v = computeAnalyzeTabVisibility({
      ...base,
      mode: "compare_humans",
      isCoordinator: true,
    });
    expect(v).toEqual({
      showAutoReview: false,
      showArbitragem: false,
      showCompare: true,
    });
  });

  it("compare_llm → Comparar", () => {
    const v = computeAnalyzeTabVisibility({
      ...base,
      mode: "compare_llm",
      isCoordinator: true,
    });
    expect(v.showCompare).toBe(true);
    expect(v.showAutoReview).toBe(false);
  });

  it("none → nenhuma aba de revisão", () => {
    const v = computeAnalyzeTabVisibility({
      ...base,
      mode: "none",
      isCoordinator: true,
    });
    expect(v).toEqual({
      showAutoReview: false,
      showArbitragem: false,
      showCompare: false,
    });
  });
});

describe("computeAnalyzeTabVisibility — pesquisador vê o trabalho ativo", () => {
  it("sem trabalho ativo, qualquer modo → nada (não-coordenador)", () => {
    const v = computeAnalyzeTabVisibility({ ...base, mode: "compare_humans" });
    expect(v).toEqual({
      showAutoReview: false,
      showArbitragem: false,
      showCompare: false,
    });
  });

  it("tem comparacao → vê Comparar mesmo se o modo mudou para auto_review_llm", () => {
    const v = computeAnalyzeTabVisibility({
      ...base,
      mode: "auto_review_llm",
      hasComparacaoAssignment: true,
    });
    expect(v.showCompare).toBe(true);
  });

  it("tem ciclo ativo de auto-revisão → vê a aba mesmo em modo de comparação", () => {
    const v = computeAnalyzeTabVisibility({
      ...base,
      mode: "compare_humans",
      hasPendingAutoReview: true,
    });
    expect(v.showAutoReview).toBe(true);
  });
});
