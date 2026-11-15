import { describe, it, expect } from "vitest";
import {
  commentFilterType,
  formatVerdictLabel,
} from "@/components/stats/comment-card-utils";

describe("formatVerdictLabel", () => {
  it.each([
    ["ambiguo", "Ambíguo"],
    ["pular", "Pular"],
    ["nota", "Nota do pesquisador"],
    ["ambiguidade", "Campo ambíguo"],
    // O `multi` votado na grade é JSON `{opção: bool}`: lista das marcadas.
    ['{"A":true,"B":false,"C":true}', "A, C"],
    ['{"A":false}', "(nenhuma)"],
    ["{não é JSON", "{não é JSON"],
    ["Deferido", "Deferido"],
  ])("%s vira %s", (verdict, label) => {
    expect(formatVerdictLabel(verdict)).toBe(label);
  });
});

// #680: o veredito "Ambíguo" de uma revisão e a discussão do campo que ele
// gera são tipos distintos no seletor; qualquer outro veredito é resposta.
describe("commentFilterType", () => {
  it.each([
    ["ambiguo", "ambiguo"],
    ["ambiguidade", "ambiguidade"],
    ["anotacao", "anotacao"],
    ["pular", "pular"],
    ["Deferido", "answer"],
  ])("%s cai no tipo %s", (verdict, type) => {
    expect(commentFilterType(verdict)).toBe(type);
  });
});
