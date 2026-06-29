import { describe, it, expect } from "vitest";
import { isCodingComplete } from "@/lib/coding-completeness";
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

describe("isCodingComplete", () => {
  it("todos os campos obrigatórios respondidos → true", () => {
    const fields = [field({ name: "q1" }), field({ name: "q2" })];
    expect(isCodingComplete(fields, { q1: "a", q2: "b" })).toBe(true);
  });

  it("campo obrigatório ausente → false", () => {
    const fields = [field({ name: "q1" }), field({ name: "q2" })];
    expect(isCodingComplete(fields, { q1: "a" })).toBe(false);
  });

  it("campo obrigatório com string vazia → false", () => {
    const fields = [field({ name: "q1" })];
    expect(isCodingComplete(fields, { q1: "" })).toBe(false);
  });

  it("sem campos → true (nada exigido)", () => {
    expect(isCodingComplete([], {})).toBe(true);
  });

  it("campo required:false ausente → true (não exigido)", () => {
    const fields = [field({ name: "q1", required: false })];
    expect(isCodingComplete(fields, {})).toBe(true);
  });

  it("campo target=llm_only ausente → true (não é do humano)", () => {
    const fields = [field({ name: "q1", target: "llm_only" })];
    expect(isCodingComplete(fields, {})).toBe(true);
  });

  it("campo target=none ausente → true (oculto)", () => {
    const fields = [field({ name: "q1", target: "none" })];
    expect(isCodingComplete(fields, {})).toBe(true);
  });

  it("condicional não-visível ausente → true (não exigido)", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    // q1='nao' → q2 invisível → não exigido, mesmo ausente
    expect(isCodingComplete(fields, { q1: "nao" })).toBe(true);
  });

  it("condicional visível não respondido → false", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    // q1='sim' → q2 visível e exigido, mas ausente
    expect(isCodingComplete(fields, { q1: "sim" })).toBe(false);
    // q2 preenchido → completo
    expect(isCodingComplete(fields, { q1: "sim", q2: "a" })).toBe(true);
  });

  it("multi com array vazio → false", () => {
    const fields = [field({ name: "q1", type: "multi" })];
    expect(isCodingComplete(fields, { q1: [] })).toBe(false);
  });

  it("multi preenchido → true", () => {
    const fields = [field({ name: "q1", type: "multi" })];
    expect(isCodingComplete(fields, { q1: ["a"] })).toBe(true);
  });

  it("single com 'Outro: ' incompleto → false", () => {
    const fields = [field({ name: "q1", allow_other: true })];
    expect(isCodingComplete(fields, { q1: "Outro: " })).toBe(false);
    expect(isCodingComplete(fields, { q1: "Outro: cibavax" })).toBe(true);
  });

  it("multi com 'Outro: ' incompleto na lista → false", () => {
    const fields = [field({ name: "q1", type: "multi", allow_other: true })];
    expect(isCodingComplete(fields, { q1: ["a", "Outro: "] })).toBe(false);
    expect(isCodingComplete(fields, { q1: ["a", "Outro: x"] })).toBe(true);
  });

  it("codificação quase vazia (1 de vários) → false", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2" }),
      field({ name: "q3", type: "text", options: null }),
      field({ name: "q4" }),
    ];
    expect(isCodingComplete(fields, { q1: "a" })).toBe(false);
  });
});

// Staleness-awareness (#174 follow-up): quando answer_field_hashes é fornecido,
// um campo obrigatório ausente do snapshot não existia quando a resposta foi
// codificada e não deve reprovar a completude. Sem isto, um campo adicionado ao
// schema depois (ex.: `medicamento`) tornaria toda codificação antiga
// falsamente "incompleta" na avaliação retroativa do backlog.
describe("isCodingComplete — staleness-aware", () => {
  it("campo obrigatório ausente do schema da época (não está nos hashes) → não exigido → true", () => {
    const fields = [field({ name: "q1" }), field({ name: "medicamento", type: "multi" })];
    // hashes da época só tinha q1 → medicamento não existia → não exigir
    const hashes = { q1: "h1" };
    expect(isCodingComplete(fields, { q1: "a" }, hashes)).toBe(true);
  });

  it("campo obrigatório que existia (está nos hashes) mas não respondido → false", () => {
    const fields = [field({ name: "q1" }), field({ name: "q2" })];
    const hashes = { q1: "h1", q2: "h2" };
    expect(isCodingComplete(fields, { q1: "a" }, hashes)).toBe(false);
    expect(isCodingComplete(fields, { q1: "a", q2: "b" }, hashes)).toBe(true);
  });

  it("hashes vazios = legacy → exige todos (comportamento staleness-blind)", () => {
    const fields = [field({ name: "q1" }), field({ name: "medicamento", type: "multi" })];
    expect(isCodingComplete(fields, { q1: "a" }, {})).toBe(false);
  });

  it("sem hashes = legacy → exige todos (comportamento staleness-blind do save-time)", () => {
    const fields = [field({ name: "q1" }), field({ name: "medicamento", type: "multi" })];
    expect(isCodingComplete(fields, { q1: "a" })).toBe(false);
  });

  it("campo da época respondido + campo novo (fora dos hashes) ausente → true", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2" }),
      field({ name: "medicamento", type: "multi" }),
    ];
    const hashes = { q1: "h1", q2: "h2" };
    // q1/q2 respondidos, medicamento (novo) ausente → completo
    expect(isCodingComplete(fields, { q1: "a", q2: "b" }, hashes)).toBe(true);
  });
});
