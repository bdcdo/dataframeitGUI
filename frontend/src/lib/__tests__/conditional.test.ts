import { describe, it, expect } from "vitest";
import { clearHiddenConditionalAnswers } from "@/lib/conditional";
import type { PydanticField } from "@/lib/types";

// Helper: monta um PydanticField com defaults mínimos.
function field(partial: Partial<PydanticField> & { name: string }): PydanticField {
  return {
    type: "single",
    options: ["a", "b"],
    description: "",
    ...partial,
  } as PydanticField;
}

describe("clearHiddenConditionalAnswers", () => {
  it("zera a resposta de uma condicional que ficou invisível", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    // q1 mudou para "não" → q2 não está mais visível, mas tem resposta órfã.
    const result = clearHiddenConditionalAnswers(fields, { q1: "não", q2: "a" });
    expect(result.q2).toBeNull();
    expect(result.q1).toBe("não");
  });

  it("preserva a resposta de uma condicional ainda visível", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    const answers = { q1: "sim", q2: "a" };
    const result = clearHiddenConditionalAnswers(fields, answers);
    expect(result).toBe(answers); // nada mudou → mesma referência
    expect(result.q2).toBe("a");
  });

  it("aplica ponto-fixo em cascata: A esconde B, B esconde C", () => {
    const fields = [
      field({ name: "a" }),
      field({ name: "b", condition: { field: "a", equals: "sim" } }),
      field({ name: "c", condition: { field: "b", equals: "sim" } }),
    ];
    // a="não" esconde b; ao limpar b, c (que dependia de b="sim") também some.
    const result = clearHiddenConditionalAnswers(fields, {
      a: "não",
      b: "sim",
      c: "x",
    });
    expect(result.b).toBeNull();
    expect(result.c).toBeNull();
    expect(result.a).toBe("não");
  });

  it("retorna o mesmo objeto quando não há nada a limpar (identidade preservada)", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    const answers = { q1: "sim" }; // q2 visível e sem resposta
    expect(clearHiddenConditionalAnswers(fields, answers)).toBe(answers);
  });

  it("não toca campos sem condition (sempre visíveis)", () => {
    const fields = [field({ name: "q1" }), field({ name: "q2" })];
    const answers = { q1: "a", q2: "b" };
    const result = clearHiddenConditionalAnswers(fields, answers);
    expect(result).toBe(answers);
  });

  it("não cria churn para condicional invisível já vazia", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    const answers = { q1: "não" }; // q2 invisível e sem resposta
    expect(clearHiddenConditionalAnswers(fields, answers)).toBe(answers);
  });

  it("não muta o objeto de entrada", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    const answers = { q1: "não", q2: "a" };
    clearHiddenConditionalAnswers(fields, answers);
    expect(answers.q2).toBe("a"); // entrada intacta
  });
});
