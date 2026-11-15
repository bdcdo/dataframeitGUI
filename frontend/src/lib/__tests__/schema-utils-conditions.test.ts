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
      'Campo 2 ("q26"): valor "NatJus aponta incerteza" não está nas opções de "q25"',
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
      'Campo 2 ("q1"): nome duplicado',
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
      `Campo 2 ("q2"): id "${id}" duplicado`,
    );
  });
});

describe("validateGUIFields — nomes que o código gerado não compila", () => {
  const PRIVATE = 'não pode começar com "_" (o Pydantic não aceita)';

  it("rejeita nome de campo que começa e termina com __", () => {
    const fields = [
      baseField({ name: "__class__", type: "text", description: "x" }),
    ];
    expect(validateGUIFields(fields)).toContain(
      `Campo 1 ("__class__"): nome ${PRIVATE}`,
    );
  });

  it("aceita nome com __ interno", () => {
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
      `Campo 1 ("doc"): subcampo "__init__" ${PRIVATE}`,
    );
  });

  // "__"/"___" já eram recusados como dunder estrito; com a regra do `_`
  // inicial, também `_x` e `_` (o Pydantic recusa todo nome privado).
  it.each(["_", "__", "___", "_x", "_x_"])(
    "rejeita nome com _ inicial %s (o Pydantic recusa campo privado)",
    (name) => {
      const fields = [baseField({ name, type: "text", description: "x" })];
      expect(validateGUIFields(fields)).toContain(
        `Campo 1 ("${name}"): nome ${PRIVATE}`,
      );
    },
  );

  it.each(["class", "def", "if", "lambda", "async", "yield"])(
    "rejeita palavra reservada do Python %s",
    (name) => {
      const fields = [baseField({ name, type: "text", description: "x" })];
      expect(validateGUIFields(fields)).toContain(
        `Campo 1 ("${name}"): nome é palavra reservada do Python`,
      );
    },
  );

  it.each(["model_config", "model_dump", "model_validate"])(
    "rejeita nome reservado pelo Pydantic %s",
    (name) => {
      const fields = [baseField({ name, type: "text", description: "x" })];
      expect(validateGUIFields(fields)).toContain(
        `Campo 1 ("${name}"): nome é reservado pelo Pydantic`,
      );
    },
  );

  it("rejeita palavra reservada como chave de subcampo", () => {
    const fields = [
      baseField({
        name: "doc",
        type: "text",
        description: "doc",
        subfields: [{ key: "from", label: "De", required: true }],
      }),
    ];
    expect(validateGUIFields(fields)).toContain(
      'Campo 1 ("doc"): subcampo "from" é palavra reservada do Python',
    );
  });

  // Compilam: palavra-chave leve do Python e atributo do BaseModel que o
  // Pydantic só avisa que sombreia.
  it.each(["match", "case", "type", "json", "model_fields", "str"])(
    "aceita %s, que o compilador aceita",
    (name) => {
      const fields = [baseField({ name, type: "text", description: "x" })];
      expect(validateGUIFields(fields)).toEqual([]);
    },
  );
});

// #502: erro estrutural do Zod (texto em inglês) vira mensagem pt-BR que
// nomeia o campo e a propriedade.
describe("validateGUIFields — erro estrutural", () => {
  it("nomeia campo e propriedade", () => {
    const broken = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "q1",
        type: "text",
        options: null,
        description: "Pergunta",
        target: "todos",
        extra: 1,
      },
    ] as unknown as PydanticField[];
    expect(validateGUIFields(broken)).toEqual([
      'Campo 1 ("q1"): formato inválido em target',
      'Campo 1 ("q1"): formato inválido em extra',
    ]);
  });
});

// A aba Schema e o EditFieldDialog não numeram os campos: a posição sozinha
// obrigava a contar cards até o culpado. O nome vai junto quando existe.
describe("validateGUIFields — rótulo do campo", () => {
  it("nomeia o campo além da posição", () => {
    const fields = [
      baseField({ name: "q1", type: "text", description: "Pergunta" }),
      baseField({ name: "valor_pedido", type: "text", description: "" }),
    ];
    expect(validateGUIFields(fields)).toEqual([
      'Campo 2 ("valor_pedido"): descrição não pode ser vazia',
    ]);
  });

  it("campo sem nome fica só com a posição", () => {
    const fields = [baseField({ name: "", type: "text", description: "Pergunta" })];
    expect(validateGUIFields(fields)).toEqual([
      "Campo 1: nome inválido (use letras minúsculas, números e _)",
    ]);
  });
});
