import { describe, it, expect } from "vitest";
import {
  computeDivergentFieldNames,
  isFreeTextField,
  isDocComplete,
  findNextPendingDocIndex,
} from "@/lib/compare-divergence";
import type { EquivalencePair } from "@/lib/equivalence";
import type { PydanticField } from "@/lib/types";

function field(overrides: Partial<PydanticField>): PydanticField {
  return {
    name: "x",
    type: "text",
    options: null,
    description: "",
    target: "all",
    ...overrides,
  };
}

describe("isFreeTextField", () => {
  it("true for type=text", () => {
    expect(isFreeTextField(field({ type: "text" }))).toBe(true);
  });

  it("true for type=date", () => {
    expect(isFreeTextField(field({ type: "date" }))).toBe(true);
  });

  it("true for type=single without options", () => {
    expect(isFreeTextField(field({ type: "single", options: null }))).toBe(
      true,
    );
    expect(isFreeTextField(field({ type: "single", options: [] }))).toBe(true);
  });

  it("false for type=single with options", () => {
    expect(
      isFreeTextField(field({ type: "single", options: ["a", "b"] })),
    ).toBe(false);
  });

  it("false for type=multi (always has options conceptually)", () => {
    expect(isFreeTextField(field({ type: "multi", options: ["a"] }))).toBe(
      false,
    );
    // Even multi with empty options is not "free text" for fusion purposes
    expect(isFreeTextField(field({ type: "multi", options: [] }))).toBe(false);
  });
});

describe("computeDivergentFieldNames", () => {
  it("skips fields with target llm_only / human_only / none", () => {
    const fields = [
      field({ name: "a", target: "llm_only" }),
      field({ name: "b", target: "human_only" }),
      field({ name: "c", target: "none" }),
    ];
    const responses = [
      { id: "1", answers: { a: "x", b: "x", c: "x" } },
      { id: "2", answers: { a: "y", b: "y", c: "y" } },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual([]);
  });

  it("does not flag a field with fewer than 2 applicable responses", () => {
    const fields = [field({ name: "a" })];
    const responses = [{ id: "1", answers: { a: "x" } }];
    expect(computeDivergentFieldNames(fields, responses)).toEqual([]);
  });

  it("free-text: answers differing only by surrounding whitespace are not divergent", () => {
    const fields = [field({ name: "a", type: "text" })];
    const responses = [
      { id: "1", answers: { a: "foo" } },
      { id: "2", answers: { a: "  foo " } },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual([]);
  });

  it("free-text: different answers are divergent without pairs", () => {
    const fields = [field({ name: "a", type: "text" })];
    const responses = [
      { id: "1", answers: { a: "alpha" } },
      { id: "2", answers: { a: "beta" } },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual(["a"]);
  });

  it("free-text: pair fusing the only two distinct answers removes divergence", () => {
    const fields = [field({ name: "a", type: "text" })];
    const responses = [
      { id: "1", answers: { a: "alpha" } },
      { id: "2", answers: { a: "beta" } },
    ];
    const pairs: EquivalencePair[] = [
      { response_a_id: "1", response_b_id: "2" },
    ];
    const equivalencesByField = new Map<string, EquivalencePair[]>([
      ["a", pairs],
    ]);
    expect(
      computeDivergentFieldNames(fields, responses, equivalencesByField),
    ).toEqual([]);
  });

  it("free-text: pair fusing only some divergent answers leaves divergence", () => {
    const fields = [field({ name: "a", type: "text" })];
    const responses = [
      { id: "1", answers: { a: "alpha" } },
      { id: "2", answers: { a: "beta" } },
      { id: "3", answers: { a: "gamma" } },
    ];
    const pairs: EquivalencePair[] = [
      { response_a_id: "1", response_b_id: "2" },
    ];
    const equivalencesByField = new Map<string, EquivalencePair[]>([
      ["a", pairs],
    ]);
    expect(
      computeDivergentFieldNames(fields, responses, equivalencesByField),
    ).toEqual(["a"]);
  });

  it("multi: differing selections are divergent", () => {
    const fields = [
      field({ name: "tags", type: "multi", options: ["x", "y", "z"] }),
    ];
    const responses = [
      { id: "1", answers: { tags: ["x", "y"] } },
      { id: "2", answers: { tags: ["x"] } },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual(["tags"]);
  });

  it("multi: identical selections are not divergent", () => {
    const fields = [
      field({ name: "tags", type: "multi", options: ["x", "y"] }),
    ];
    const responses = [
      { id: "1", answers: { tags: ["x", "y"] } },
      { id: "2", answers: { tags: ["y", "x"] } },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual([]);
  });

  it("staleness: a field absent from a response's answerFieldHashes is excluded from comparison", () => {
    // `b` foi adicionado ao schema depois que a response 1 foi codificada:
    // o answerFieldHashes dela não tem a chave `b`. Sem a resposta 1, sobra
    // só 1 response aplicável para `b` → não pode divergir (não vira "(vazio)").
    const fields = [field({ name: "a" }), field({ name: "b" })];
    const responses = [
      {
        id: "1",
        answers: { a: "same" },
        answerFieldHashes: { a: "ha" } as Record<string, string>,
      },
      {
        id: "2",
        answers: { a: "same", b: "novo" },
        answerFieldHashes: { a: "ha", b: "hb" } as Record<string, string>,
      },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual([]);
  });

  it("staleness: field present in both responses' hashes still diverges normally", () => {
    const fields = [field({ name: "a" })];
    const responses = [
      { id: "1", answers: { a: "alpha" }, answerFieldHashes: { a: "ha" } },
      { id: "2", answers: { a: "beta" }, answerFieldHashes: { a: "ha" } },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual(["a"]);
  });

  it("staleness: null/absent answerFieldHashes (legacy) preserves old behavior", () => {
    // Sem o snapshot de hashes não dá para inferir staleness — mantém o
    // comportamento antigo de comparar tudo (undefined vs valor = divergente).
    const fields = [field({ name: "a" })];
    const responses = [
      { id: "1", answers: {}, answerFieldHashes: null },
      { id: "2", answers: { a: "valor" } },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual(["a"]);
  });

  it("staleness: empty answerFieldHashes {} is treated as legacy, not 'no fields'", () => {
    // Um objeto vazio (ex: PydanticFields sem `.hash` populado) não pode
    // excluir todos os campos silenciosamente — deve cair no comportamento
    // legacy de comparar tudo.
    const fields = [field({ name: "a" })];
    const responses = [
      { id: "1", answers: { a: "alpha" }, answerFieldHashes: {} },
      { id: "2", answers: { a: "beta" }, answerFieldHashes: {} },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual(["a"]);
  });
});

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

describe("findNextPendingDocIndex", () => {
  const divergentFields = { d1: ["a"], d2: ["a"], d3: ["a"] };

  it("returns the first pending doc, skipping the current one", () => {
    const reviews = {};
    expect(
      findNextPendingDocIndex(["d1", "d2", "d3"], divergentFields, reviews, "d1"),
    ).toBe(1);
  });

  it("finds a pending doc at the top after the queue was re-sorted", () => {
    // Server re-sorts completed docs to the bottom: the just-finished doc (d1)
    // is now last, pending docs are at the top. `currentIndex + 1` would point
    // past the end — the helper must still find d2 at index 0.
    const reviews = { d1: { a: {} } };
    expect(
      findNextPendingDocIndex(["d2", "d3", "d1"], divergentFields, reviews, "d1"),
    ).toBe(0);
  });

  it("skips docs that are already complete", () => {
    const reviews = { d1: { a: {} }, d2: { a: {} } };
    expect(
      findNextPendingDocIndex(["d2", "d3", "d1"], divergentFields, reviews, "d1"),
    ).toBe(1);
  });

  it("returns -1 when every other doc is complete", () => {
    const reviews = { d1: { a: {} }, d2: { a: {} }, d3: { a: {} } };
    expect(
      findNextPendingDocIndex(["d2", "d3", "d1"], divergentFields, reviews, "d1"),
    ).toBe(-1);
  });
});
