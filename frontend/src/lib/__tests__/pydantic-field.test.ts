import { describe, expect, it } from "vitest";
import { parsePydanticFields } from "../pydantic-field";

const legacyCompositeField = {
  name: "documento",
  type: "text",
  options: null,
  description: "Documento",
  subfields: [{ key: "numero", label: "Número" }],
  subfield_rule: "at_least_one",
};

describe("SubfieldDef.required", () => {
  it("normaliza payload legado ausente para false", () => {
    const fields = parsePydanticFields([legacyCompositeField]);

    expect(fields?.[0].subfields).toEqual([
      { key: "numero", label: "Número", required: false },
    ]);
  });

  it("rejeita required malformado em vez de adivinhar seu valor", () => {
    expect(
      parsePydanticFields([
        {
          ...legacyCompositeField,
          subfields: [{ key: "numero", label: "Número", required: "false" }],
        },
      ]),
    ).toBeNull();
  });
});
