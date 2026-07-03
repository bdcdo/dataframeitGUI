import { describe, it, expect } from "vitest";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
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

  it("single-com-opções: opções diferentes são divergentes sem pares", () => {
    const fields = [
      field({ name: "s", type: "single", options: ["NI", "N/A", "Sim"] }),
    ];
    const responses = [
      { id: "1", answers: { s: "NI" } },
      { id: "2", answers: { s: "N/A" } },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual(["s"]);
  });

  it("single-com-opções: par fundindo NI ≡ N/A remove a divergência (#247, ponto 5)", () => {
    const fields = [
      field({ name: "s", type: "single", options: ["NI", "N/A", "Sim"] }),
    ];
    const responses = [
      { id: "1", answers: { s: "NI" } },
      { id: "2", answers: { s: "N/A" } },
    ];
    const equivalencesByField = new Map<string, EquivalencePair[]>([
      ["s", [{ response_a_id: "1", response_b_id: "2" }]],
    ]);
    expect(
      computeDivergentFieldNames(fields, responses, equivalencesByField),
    ).toEqual([]);
  });

  it("single-com-opções: par cobrindo só parte das opções deixa divergência", () => {
    const fields = [
      field({ name: "s", type: "single", options: ["NI", "N/A", "Sim"] }),
    ];
    const responses = [
      { id: "1", answers: { s: "NI" } },
      { id: "2", answers: { s: "N/A" } },
      { id: "3", answers: { s: "Sim" } },
    ];
    const equivalencesByField = new Map<string, EquivalencePair[]>([
      ["s", [{ response_a_id: "1", response_b_id: "2" }]],
    ]);
    expect(
      computeDivergentFieldNames(fields, responses, equivalencesByField),
    ).toEqual(["s"]);
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

  it("staleness: asymmetric legacy human + modern LLM without the field — does not diverge", () => {
    // Cenário real de migração: humano codificou antes da coluna
    // `answer_field_hashes` existir (hashes=null, legacy → considera-se que
    // tinha o campo); LLM re-rodou depois com hashes modernos mas o campo
    // não está nos hashes dele (campo foi removido do schema antes do LLM
    // re-rodar). Só 1 response aplicável → não diverge.
    const fields = [field({ name: "removido" })];
    const responses = [
      { id: "1", answers: { removido: "humano" }, answerFieldHashes: null },
      {
        id: "2",
        answers: { removido: "llm" },
        answerFieldHashes: { outro: "h" } as Record<string, string>,
      },
    ];
    expect(computeDivergentFieldNames(fields, responses)).toEqual([]);
  });
});
