import { describe, expect, it } from "vitest";
import {
  buildFieldHashMap,
  fieldExistedWhenCoded,
  isFieldStale,
} from "@/lib/answer-staleness";
import type { PydanticField } from "@/lib/types";

const field = (input: Partial<PydanticField> & { name: string }): PydanticField =>
  ({ type: "text", options: null, description: input.name, ...input }) as PydanticField;

describe("buildFieldHashMap", () => {
  it("inclui todo campo e usa null quando o hash é desconhecido", () => {
    const result = buildFieldHashMap([
      field({ name: "a", hash: "h1" }),
      field({ name: "sem_hash" }),
      field({ name: "constructor", hash: "hc" }),
    ]);

    expect(result).toEqual({ a: "h1", sem_hash: null, constructor: "hc" });
    expect(Object.hasOwn(result, "constructor")).toBe(true);
  });
});

describe("fieldExistedWhenCoded", () => {
  it("usa a presença própria da chave, inclusive quando o hash é null", () => {
    expect(fieldExistedWhenCoded({ q: null }, "q")).toBe(true);
    expect(fieldExistedWhenCoded({ a: "h1" }, "b")).toBe(false);
    expect(fieldExistedWhenCoded({ a: "h1" }, "constructor")).toBe(false);
  });

  it("trata null, undefined e objeto vazio como legacy", () => {
    expect(fieldExistedWhenCoded(null, "q")).toBe(true);
    expect(fieldExistedWhenCoded(undefined, "q")).toBe(true);
    expect(fieldExistedWhenCoded({}, "q")).toBe(true);
  });
});

describe("isFieldStale", () => {
  const base = {
    pydanticHash: "p1",
    fieldName: "q",
    currentFieldHashes: { q: "h1" },
    projectPydanticHash: "p1",
  };

  it("compara hashes conhecidos", () => {
    expect(isFieldStale({ ...base, answerFieldHashes: { q: "h1" } })).toBe(false);
    expect(isFieldStale({ ...base, answerFieldHashes: { q: "h-old" } })).toBe(true);
  });

  it("hash null ou chave própria ausente é stale", () => {
    expect(isFieldStale({ ...base, answerFieldHashes: { q: null } })).toBe(true);
    expect(
      isFieldStale({
        ...base,
        fieldName: "constructor",
        answerFieldHashes: { q: "h1" },
        currentFieldHashes: { constructor: "hc" },
      }),
    ).toBe(true);
  });

  it("null e objeto vazio usam o fallback do schema inteiro", () => {
    expect(
      isFieldStale({
        ...base,
        answerFieldHashes: null,
        pydanticHash: "p-old",
        projectPydanticHash: "p-new",
      }),
    ).toBe(true);
    expect(isFieldStale({ ...base, answerFieldHashes: {} })).toBe(false);
    expect(
      isFieldStale({
        ...base,
        answerFieldHashes: {},
        pydanticHash: "p-old",
        projectPydanticHash: "p-new",
      }),
    ).toBe(true);
  });
});
