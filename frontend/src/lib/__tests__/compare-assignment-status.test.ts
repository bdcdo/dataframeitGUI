import { describe, it, expect } from "vitest";
import { isDocComplete, resolveCompareStatus } from "@/lib/compare-assignment-status";

describe("isDocComplete", () => {
  it("false when there are no divergent fields", () => {
    expect(isDocComplete([], { a: {} })).toBe(false);
    expect(isDocComplete(undefined, { a: {} })).toBe(false);
  });

  it("false when there are no reviews for the doc", () => {
    expect(isDocComplete(["a", "b"], undefined)).toBe(false);
  });

  it("false when some divergent field is still unreviewed", () => {
    expect(isDocComplete(["a", "b"], { a: {} })).toBe(false);
  });

  it("true when every divergent field has a verdict", () => {
    expect(isDocComplete(["a", "b"], { a: {}, b: {} })).toBe(true);
  });
});

describe("resolveCompareStatus", () => {
  it("concluido quando todos os campos divergentes foram revisados", () => {
    expect(resolveCompareStatus(["a", "b"], new Set(["a", "b"]))).toBe(
      "concluido",
    );
  });

  // #217: edge `divergentFields.length === 0` — antes ficava preso em
  // em_andamento; um doc sem divergências (ex.: todas fundidas por equivalência)
  // agora fecha, mesmo sem reviews (`every` é vácuo-verdadeiro).
  it("concluido quando não há campos divergentes (lista vazia)", () => {
    expect(resolveCompareStatus([], new Set())).toBe("concluido");
    expect(resolveCompareStatus([], new Set(["a"]))).toBe("concluido");
  });

  it("pendente quando há divergências e nenhuma review", () => {
    expect(resolveCompareStatus(["a", "b"], new Set())).toBe("pendente");
  });

  it("em_andamento quando há divergências não revisadas mas alguma review", () => {
    expect(resolveCompareStatus(["a", "b"], new Set(["a"]))).toBe(
      "em_andamento",
    );
  });
});
