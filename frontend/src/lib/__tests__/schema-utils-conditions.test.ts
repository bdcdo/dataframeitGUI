import { describe, it, expect } from "vitest";
import {
  findConditionConflicts,
  stripOptionFromConditions,
  validateGUIFields,
} from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";

let fieldIdSeq = 0;
const nextFieldId = (): string => {
  fieldIdSeq += 1;
  return `00000000-0000-4000-8000-0000000000${String(fieldIdSeq).padStart(2, "0")}`;
};

const baseField = (over: Partial<PydanticField>): PydanticField => ({
  id: nextFieldId(),
  name: "x",
  type: "single",
  description: "x",
  options: null,
  ...over,
});

describe("findConditionConflicts", () => {
  it("returns empty when no field references the option", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A", "B"] }),
      baseField({ name: "q2", type: "text" }),
    ];
    expect(findConditionConflicts(fields, "q1", "A")).toEqual([]);
  });

  it("flags equals match", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A", "B"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "q1", equals: "A" },
      }),
    ];
    const c = findConditionConflicts(fields, "q1", "A");
    expect(c).toEqual([
      { fieldName: "q2", fieldLabel: "Campo 2", conditionKey: "equals" },
    ]);
  });

  it("flags in match and skips unrelated", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A", "B", "C"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "q1", in: ["A", "B"] },
      }),
      baseField({
        name: "q3",
        type: "text",
        condition: { field: "q1", in: ["C"] },
      }),
    ];
    expect(findConditionConflicts(fields, "q1", "A")).toEqual([
      { fieldName: "q2", fieldLabel: "Campo 2", conditionKey: "in" },
    ]);
  });

  it("ignores conditions that target a different trigger field", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A"] }),
      baseField({ name: "q2", options: ["A"] }),
      baseField({
        name: "q3",
        type: "text",
        condition: { field: "q2", equals: "A" },
      }),
    ];
    expect(findConditionConflicts(fields, "q1", "A")).toEqual([]);
  });
});

describe("stripOptionFromConditions", () => {
  it("filters value from in list", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A", "B"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "q1", in: ["A", "B"] },
      }),
    ];
    const next = stripOptionFromConditions(fields, "q1", "A");
    expect(next[1].condition).toEqual({ field: "q1", in: ["B"] });
  });

  it("removes the entire condition when in becomes empty", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "q1", in: ["A"] },
      }),
    ];
    const next = stripOptionFromConditions(fields, "q1", "A");
    expect(next[1].condition).toBeUndefined();
  });

  it("removes the entire condition on equals match", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "q1", equals: "A" },
      }),
    ];
    const next = stripOptionFromConditions(fields, "q1", "A");
    expect(next[1].condition).toBeUndefined();
  });

  it("does not touch unrelated conditions", () => {
    const fields: PydanticField[] = [
      baseField({ name: "q1", options: ["A"] }),
      baseField({
        name: "q2",
        type: "text",
        condition: { field: "other", equals: "A" },
      }),
    ];
    const next = stripOptionFromConditions(fields, "q1", "A");
    expect(next[1].condition).toEqual({ field: "other", equals: "A" });
  });
});

describe("after strip, validateGUIFields should pass", () => {
  it("reproduces the Zolgensma scenario then fixes it", () => {
    // q25 sem "NatJus aponta incerteza", q26 com condition que referencia.
    const fields: PydanticField[] = [
      baseField({
        name: "q25",
        options: ["Sim", "Sim, com ressalvas"],
        description: "q25",
      }),
      baseField({
        name: "q26",
        type: "text",
        description: "q26",
        condition: {
          field: "q25",
          in: ["Sim, com ressalvas", "NatJus aponta incerteza"],
        },
      }),
    ];
    expect(validateGUIFields(fields)).toContain(
      'Campo 2: valor "NatJus aponta incerteza" não está nas opções de "q25"',
    );

    const fixed = stripOptionFromConditions(fields, "q25", "NatJus aponta incerteza");
    expect(validateGUIFields(fixed)).toEqual([]);
  });
});

// Esta é a fronteira em que o PR da #473 se apoiou ao soltar o bloqueio de
// tecla do `FieldNameInput`: nome duplicado passou a ser estado transitório
// legítimo do editor (é o que torna "q2" -> "q10" possível com "q1" presente),
// e quem recusa é o save. Sem este teste a premissa da mudança fica só no
// comentário — e o editor teria soltado a trava contra uma garantia não medida.
describe("validateGUIFields — unicidade de nome no save", () => {
  it("rejeita dois campos com o mesmo nome, apontando o índice do segundo", () => {
    const fields = [
      baseField({ name: "q1", type: "text" }),
      baseField({ name: "q1", type: "text" }),
    ];
    expect(validateGUIFields(fields)).toContain(
      'Campo 2: nome "q1" duplicado',
    );
  });

  it("aceita os mesmos campos assim que o nome deixa de colidir", () => {
    const fields = [
      baseField({ name: "q1", type: "text" }),
      baseField({ name: "q10", type: "text" }),
    ];
    expect(validateGUIFields(fields)).toEqual([]);
  });

  // Ids distintos são o que separa "dois campos disputando um nome" de "o mesmo
  // campo duas vezes". O save recusa o primeiro caso pelo NOME; o id duplicado
  // é recusado por outra regra, e as duas mensagens não podem se confundir.
  it("rejeita id duplicado mesmo com nomes distintos", () => {
    const id = "00000000-0000-4000-8000-0000000000ff";
    const fields = [
      { ...baseField({ name: "q1", type: "text" }), id },
      { ...baseField({ name: "q2", type: "text" }), id },
    ];
    expect(validateGUIFields(fields)).toContain(
      `Campo 2: id "${id}" duplicado`,
    );
  });
});

describe("validateGUIFields — nomes dunder", () => {
  it("rejeita nome de campo que começa e termina com __", () => {
    const fields = [
      baseField({ name: "__class__", type: "text", description: "x" }),
    ];
    expect(validateGUIFields(fields)).toContain(
      'Campo 1: nome "__class__" não pode começar e terminar com "__" (reservado pelo Python)',
    );
  });

  it("aceita nome com __ interno (não é dunder estrito)", () => {
    const fields = [
      baseField({ name: "my__field", type: "text", description: "x" }),
    ];
    expect(validateGUIFields(fields)).toEqual([]);
  });

  it("rejeita chave de subcampo dunder estrito", () => {
    const fields = [
      baseField({
        name: "doc",
        type: "text",
        description: "doc",
        subfields: [{ key: "__init__", label: "Init", required: true }],
      }),
    ];
    expect(validateGUIFields(fields)).toContain(
      'Campo 1: subcampo "__init__" não pode começar e terminar com "__" (reservado pelo Python)',
    );
  });

  // Antes a regex /^__.*__$/ exigia ≥4 chars e NÃO casava "__"/"___", que o
  // backend (startswith E endswith "__") rejeita — divergência que gerava
  // código recusado no run. isStrictDunder espelha o backend.
  it.each(["__", "___", "____"])(
    "rejeita nome só de underscores %s (alinhado ao backend)",
    (name) => {
      const fields = [baseField({ name, type: "text", description: "x" })];
      expect(validateGUIFields(fields)).toContain(
        `Campo 1: nome "${name}" não pode começar e terminar com "__" (reservado pelo Python)`,
      );
    },
  );
});
