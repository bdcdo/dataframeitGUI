import { describe, it, expect } from "vitest";
import {
  computeDivergentFieldNames,
  isFreeTextField,
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
});
