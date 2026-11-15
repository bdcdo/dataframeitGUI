import { describe, expect, it } from "vitest";
import { fieldTypeChangePatch } from "@/lib/field-type-change";
import type { PydanticField } from "@/lib/types";

const TYPES = ["single", "multi", "text", "date"] as const;
const ID = "00000000-0000-4000-8000-000000000001";

// Um campo de cada tipo com tudo o que o tipo admite preenchido.
const LOADED: Record<PydanticField["type"], PydanticField> = {
  single: {
    id: ID,
    name: "q",
    type: "single",
    options: ["Sim", "Não"],
    description: "Q",
    allow_other: true,
  },
  multi: {
    id: ID,
    name: "q",
    type: "multi",
    options: ["A", "B"],
    description: "Q",
    allow_other: true,
  },
  text: {
    id: ID,
    name: "q",
    type: "text",
    options: null,
    description: "Q",
    subfields: [{ key: "a", label: "A", required: true }],
    subfield_rule: "at_least_one",
  },
  date: {
    id: ID,
    name: "q",
    type: "date",
    options: ["Não identificável"],
    description: "Q",
  },
};

function applyChange(
  from: PydanticField["type"],
  to: PydanticField["type"],
): PydanticField {
  const field = LOADED[from];
  return { ...field, ...fieldTypeChangePatch(field, to) };
}

describe("fieldTypeChangePatch", () => {
  for (const from of TYPES) {
    for (const to of TYPES.filter((t) => t !== from)) {
      it(`${from} -> ${to} não carrega propriedade de outro tipo`, () => {
        const changed = applyChange(from, to);
        expect(changed.type).toBe(to);
        if (to !== "single" && to !== "multi") {
          expect(changed.allow_other).toBeUndefined();
        }
        if (to !== "text") {
          expect(changed.subfields).toBeUndefined();
          expect(changed.subfield_rule).toBeUndefined();
        }
      });
    }
  }

  it("mantém allow_other entre os tipos de escolha", () => {
    expect(applyChange("single", "multi").allow_other).toBe(true);
    expect(applyChange("multi", "single").allow_other).toBe(true);
  });

  it("mantém as opções entre escolhas e semeia uma quando não há", () => {
    expect(applyChange("single", "multi").options).toEqual(["Sim", "Não"]);
    expect(applyChange("text", "single").options).toEqual(["Opção 1"]);
  });

  it("zera as opções ao ir para texto e as mantém ao ir para data", () => {
    expect(applyChange("single", "text").options).toBeNull();
    expect(applyChange("single", "date").options).toEqual(["Sim", "Não"]);
    expect(applyChange("text", "date").options).toBeNull();
  });

  // Antes, clicar em "Texto livre" num campo de texto zerava as respostas
  // padronizadas dele.
  it("clicar no tipo atual não muda nada", () => {
    for (const type of TYPES) {
      expect(fieldTypeChangePatch(LOADED[type], type)).toEqual({});
    }
    const withShortcuts: PydanticField = {
      ...LOADED.text,
      subfields: undefined,
      options: ["NA"],
    };
    expect(fieldTypeChangePatch(withShortcuts, "text")).toEqual({});
  });
});
