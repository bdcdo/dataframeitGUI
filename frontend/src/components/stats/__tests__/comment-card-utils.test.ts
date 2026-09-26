import { describe, it, expect } from "vitest";
import { formatVerdictLabel } from "@/components/stats/comment-card-utils";

describe("formatVerdictLabel", () => {
  it.each([
    ["ambiguo", "Ambíguo"],
    ["pular", "Pular"],
    ["nota", "Nota do pesquisador"],
    // O `multi` votado na grade é JSON `{opção: bool}`: lista das marcadas.
    ['{"A":true,"B":false,"C":true}', "A, C"],
    ['{"A":false}', "(nenhuma)"],
    ["{não é JSON", "{não é JSON"],
    ["Deferido", "Deferido"],
  ])("%s vira %s", (verdict, label) => {
    expect(formatVerdictLabel(verdict)).toBe(label);
  });
});
