import { describe, expect, it } from "vitest";
import {
  automationModeRequiresLlm,
  getAvailableAutomationModes,
  getDefaultAutomationMode,
  isAutomationMode,
  isAutomationModeAvailable,
} from "@/lib/automation-modes";

describe("contrato dos modos de automação", () => {
  it("mantém o default histórico quando LLM está ligado", () => {
    expect(getDefaultAutomationMode(true)).toBe("auto_review_llm");
    expect(getAvailableAutomationModes(true).map(({ value }) => value)).toEqual([
      "none",
      "auto_review_llm",
      "compare_humans",
      "compare_llm",
    ]);
  });

  it("usa none como default e oferece só modos sem LLM quando desligado", () => {
    expect(getDefaultAutomationMode(false)).toBe("none");
    expect(getAvailableAutomationModes(false).map(({ value }) => value)).toEqual([
      "none",
      "compare_humans",
    ]);
  });

  it("deriva validação e requisito de LLM do mesmo contrato", () => {
    expect(isAutomationMode("compare_llm")).toBe(true);
    expect(isAutomationMode("inventado")).toBe(false);
    expect(automationModeRequiresLlm("auto_review_llm")).toBe(true);
    expect(automationModeRequiresLlm("compare_humans")).toBe(false);
    expect(isAutomationModeAvailable("compare_llm", false)).toBe(false);
    expect(isAutomationModeAvailable("compare_humans", false)).toBe(true);
  });
});
