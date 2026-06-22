import { describe, it, expect } from "vitest";
import {
  DEFAULT_COMPARE_FILTERS,
  readCompareFilters,
  compareDefaultsForMode,
} from "@/lib/compare-filters";

// Estes testes cobrem a peça que liga a Comparação de "1 humano + 1 LLM": o
// piso de "mín. humanos" passa a ser derivado do automation_mode do projeto
// (compareDefaultsForMode), espelhando o gatilho createAutoComparisonIfDiverges
// (lib/auto-comparison.ts). Sem isto, compare_llm (1 codificador) nunca
// alcançaria o piso fixo de 2 e a aba ficaria vazia.

describe("compareDefaultsForMode", () => {
  it("compare_llm baixa o piso de humanos para 1 (a 2ª resposta é o LLM)", () => {
    expect(compareDefaultsForMode("compare_llm", 2).minHumans).toBe(1);
    // independe de min_responses_for_comparison
    expect(compareDefaultsForMode("compare_llm", 5).minHumans).toBe(1);
  });

  it("compare_humans usa min_responses_for_comparison", () => {
    expect(compareDefaultsForMode("compare_humans", 2).minHumans).toBe(2);
    expect(compareDefaultsForMode("compare_humans", 3).minHumans).toBe(3);
    // nunca abaixo de 1, mesmo com config inválida
    expect(compareDefaultsForMode("compare_humans", 0).minHumans).toBe(1);
  });

  it("auto_review_llm / none / null / undefined / desconhecido mantêm o piso base (2)", () => {
    expect(compareDefaultsForMode("auto_review_llm", 2).minHumans).toBe(
      DEFAULT_COMPARE_FILTERS.minHumans,
    );
    expect(compareDefaultsForMode("none", 2).minHumans).toBe(2);
    expect(compareDefaultsForMode(null, 2).minHumans).toBe(2);
    expect(compareDefaultsForMode(undefined, 2).minHumans).toBe(2);
    expect(compareDefaultsForMode("valor_legado", 2).minHumans).toBe(2);
  });

  it("preserva os demais defaults globais (só mexe em minHumans)", () => {
    const d = compareDefaultsForMode("compare_llm", 2);
    expect(d.version).toBe(DEFAULT_COMPARE_FILTERS.version);
    expect(d.minTotal).toBe(DEFAULT_COMPARE_FILTERS.minTotal);
    expect(d.minAssignedPct).toBe(DEFAULT_COMPARE_FILTERS.minAssignedPct);
    expect(d.since).toBe(DEFAULT_COMPARE_FILTERS.since);
    expect(d.respondent).toBe(DEFAULT_COMPARE_FILTERS.respondent);
  });
});

describe("readCompareFilters com defaults por modo", () => {
  it("sem param na URL, usa o piso do modo (compare_llm => 1)", () => {
    const defaults = compareDefaultsForMode("compare_llm", 2);
    expect(readCompareFilters({}, defaults).minHumans).toBe(1);
  });

  it("param min_humans na URL sobrepõe o default do modo (a revisora pode estreitar)", () => {
    const defaults = compareDefaultsForMode("compare_llm", 2);
    expect(readCompareFilters({ min_humans: "3" }, defaults).minHumans).toBe(3);
  });

  it("sem defaults explícitos, mantém o comportamento legado (piso 2)", () => {
    expect(readCompareFilters({}).minHumans).toBe(2);
  });

  it("aceita URLSearchParams além de Record, misturando default-de-modo com URL", () => {
    const defaults = compareDefaultsForMode("compare_llm", 2);
    const sp = new URLSearchParams("min_total=3");
    const f = readCompareFilters(sp, defaults);
    expect(f.minHumans).toBe(1); // veio do modo
    expect(f.minTotal).toBe(3); // veio da URL
  });
});
