import { describe, it, expect } from "vitest";
import {
  clearHiddenConditionalAnswers,
  dropHiddenConditionals,
} from "@/lib/conditional";
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

  // --- Operadores além de `equals` (a suíte original só cobria `equals`). Os
  // operadores `not_equals`/`not_in`/`exists` invertem visibilidade de forma
  // não-monotônica — zerar um gatilho pode *revelar* um dependente —, então são
  // exatamente onde um bug de ponto-fixo se esconderia. Ver #252 / revisão. ---

  it("not_equals: zera a condicional quando o gatilho bate o valor proibido", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", not_equals: "x" } }),
    ];
    // q1="x" → not_equals "x" é falso → q2 invisível → resposta órfã zerada.
    const result = clearHiddenConditionalAnswers(fields, { q1: "x", q2: "a" });
    expect(result.q2).toBeNull();
    expect(result.q1).toBe("x");
  });

  it("not_equals: preserva a condicional quando o gatilho difere do proibido", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", not_equals: "x" } }),
    ];
    const answers = { q1: "b", q2: "a" };
    const result = clearHiddenConditionalAnswers(fields, answers);
    expect(result).toBe(answers); // visível → nada muda → mesma referência
    expect(result.q2).toBe("a");
  });

  it("in: zera a condicional quando o gatilho está fora do conjunto", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", in: ["a", "b"] } }),
    ];
    const result = clearHiddenConditionalAnswers(fields, { q1: "c", q2: "a" });
    expect(result.q2).toBeNull();
  });

  it("not_in: zera a condicional quando o gatilho está dentro do conjunto", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", not_in: ["a", "b"] } }),
    ];
    // q1="a" ∈ {a,b} → not_in é falso → q2 invisível → zerada.
    const result = clearHiddenConditionalAnswers(fields, { q1: "a", q2: "a" });
    expect(result.q2).toBeNull();
  });

  it("exists:false: zera a condicional quando o gatilho existe", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", exists: false } }),
    ];
    // q1 presente → exists=true → condição quer false → q2 invisível → zerada.
    const result = clearHiddenConditionalAnswers(fields, { q1: "x", q2: "a" });
    expect(result.q2).toBeNull();
  });

  it("exists: zerar um gatilho REVELA um dependente exists:false (flip não-monotônico, preserva)", () => {
    const fields = [
      field({ name: "a" }),
      field({ name: "b", condition: { field: "a", equals: "sim" } }),
      // c é visível quando b NÃO existe.
      field({ name: "c", condition: { field: "b", exists: false } }),
    ];
    // a="não" esconde b (zera para null); com b=null, c (exists:false sobre b)
    // passa a ser VISÍVEL → seu valor deve ser preservado, não zerado.
    const result = clearHiddenConditionalAnswers(fields, {
      a: "não",
      b: "sim",
      c: "x",
    });
    expect(result.b).toBeNull();
    expect(result.c).toBe("x"); // revelado pelo flip → preservado
  });

  it("condição com campo aninhado/dotado (getNestedValue)", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1.sub", equals: "x" } }),
    ];
    // q1.sub="y" ≠ "x" → q2 invisível → zerada; q1 (objeto) intacto.
    const result = clearHiddenConditionalAnswers(fields, {
      q1: { sub: "y" },
      q2: "a",
    });
    expect(result.q2).toBeNull();
    expect(result.q1).toEqual({ sub: "y" });
  });

  it("cascata com operadores mistos: equals → not_equals → exists", () => {
    const fields = [
      field({ name: "a" }),
      field({ name: "b", condition: { field: "a", equals: "sim" } }),
      field({ name: "c", condition: { field: "b", not_equals: "no" } }),
      field({ name: "d", condition: { field: "c", exists: true } }),
    ];
    // a="não" esconde b; b=null torna c invisível (not_equals com null é falso);
    // c=null torna d invisível (exists:true com null é falso). Tudo zera.
    const result = clearHiddenConditionalAnswers(fields, {
      a: "não",
      b: "sim",
      c: "x",
      d: "y",
    });
    expect(result.b).toBeNull();
    expect(result.c).toBeNull();
    expect(result.d).toBeNull();
    expect(result.a).toBe("não");
  });

  it("termina e estabiliza com condições exists mutuamente dependentes (cada campo zera no máximo uma vez)", () => {
    const fields = [
      field({ name: "x", condition: { field: "y", exists: false } }),
      field({ name: "y", condition: { field: "x", exists: false } }),
    ];
    // Ambos visíveis só quando o outro não existe. Com x e y preenchidos:
    // x é invisível (y existe) → zera x; com x=null, y passa a visível → fica.
    // O laço não oscila: um campo nulo falha o guard `v !== null` e não é
    // re-zerado, garantindo terminação (≤N passes).
    const result = clearHiddenConditionalAnswers(fields, { x: "1", y: "2" });
    expect(result.x).toBeNull();
    expect(result.y).toBe("2");
  });
});

// Variante de fronteira (leitura/escrita persistida): mesma lógica de ponto-fixo
// que `clearHiddenConditionalAnswers`, mas OMITE a chave em vez de setá-la `null`
// — alinhada à sanitização do `saveResponse`. Ver #252.
describe("dropHiddenConditionals", () => {
  it("omite (delete) a chave de uma condicional que ficou invisível", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    const result = dropHiddenConditionals(fields, { q1: "não", q2: "a" });
    expect("q2" in result).toBe(false); // chave ausente, não null
    expect(result.q1).toBe("não");
  });

  it("preserva a condicional ainda visível (identidade quando nada muda)", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    const answers = { q1: "sim", q2: "a" };
    const result = dropHiddenConditionals(fields, answers);
    expect(result).toBe(answers); // mesma referência
    expect(result.q2).toBe("a");
  });

  it("aplica ponto-fixo em cascata, omitindo as chaves", () => {
    const fields = [
      field({ name: "a" }),
      field({ name: "b", condition: { field: "a", equals: "sim" } }),
      field({ name: "c", condition: { field: "b", equals: "sim" } }),
    ];
    const result = dropHiddenConditionals(fields, { a: "não", b: "sim", c: "x" });
    expect("b" in result).toBe(false);
    expect("c" in result).toBe(false);
    expect(result.a).toBe("não");
  });

  it("não muta o objeto de entrada", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    const answers = { q1: "não", q2: "a" };
    dropHiddenConditionals(fields, answers);
    expect(answers.q2).toBe("a"); // entrada intacta
  });
});
