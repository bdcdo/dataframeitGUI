import { describe, expect, it } from "vitest";
import {
  SCHEMA_DRAFT_FORMAT_VERSION,
  parseSchemaDraft,
} from "@/lib/schema-draft";
import { PYDANTIC_FIELD_PROPERTY_KEYS } from "@/lib/pydantic-field";
import { schemaFieldsFingerprint, snapshotOf } from "@/lib/schema-utils";
import type { FieldCondition, PydanticField } from "@/lib/types";

const trigger: PydanticField = {
  name: "gatilho",
  type: "single",
  options: ["Sim", "Não"],
  description: "Gatilho",
};

const complete: PydanticField = {
  name: "completo",
  type: "text",
  options: ["Não consta"],
  description: "Campo completo",
  help_text: "Ajuda",
  target: "human_only",
  required: false,
  hash: "hash-derivado",
  subfields: [{ key: "parte", label: "Parte", required: true }],
  subfield_rule: "at_least_one",
  allow_other: true,
  condition: { field: "gatilho", equals: "Sim" },
  justification_prompt: "Cite o trecho",
};

function rawDraft(fields: PydanticField[] = [trigger, complete]) {
  return JSON.stringify({
    formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
    draftId: "draft-1",
    revision: 1,
    updatedAt: 1,
    baseVersion: "0.1.0",
    baseFingerprint: schemaFieldsFingerprint([trigger]),
    fields,
  });
}

describe("parseSchemaDraft", () => {
  it("mantém o parser runtime alinhado ao snapshot canônico mais hash derivado", () => {
    expect(PYDANTIC_FIELD_PROPERTY_KEYS).toEqual(
      [...Object.keys(snapshotOf(complete)), "hash"].sort(),
    );
  });

  it("aceita todas as propriedades atuais de PydanticField", () => {
    expect(parseSchemaDraft(rawDraft())?.fields).toEqual([trigger, complete]);
  });

  it.each<FieldCondition>([
    { field: "gatilho", equals: "Sim" },
    { field: "gatilho", not_equals: "Não" },
    { field: "gatilho", in: ["Sim", "Não"] },
    { field: "gatilho", not_in: ["Não"] },
    { field: "gatilho", exists: true },
  ])("aceita a condição %#", (condition) => {
    const field = { ...complete, condition };
    expect(parseSchemaDraft(rawDraft([trigger, field]))?.fields[1].condition).toEqual(
      condition,
    );
  });

  it.each([
    ["envelope", { extra: true }],
    ["campo", { fields: [{ ...trigger, extra: true }, complete] }],
    [
      "subcampo",
      {
        fields: [trigger, { ...complete, subfields: [{ ...complete.subfields![0], extra: true }] }],
      },
    ],
    [
      "condição",
      { fields: [trigger, { ...complete, condition: { field: "gatilho", equals: "Sim", extra: true } }] },
    ],
  ])("rejeita chave desconhecida no %s", (_label, override) => {
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(parseSchemaDraft(JSON.stringify({ ...base, ...override }))).toBeNull();
  });

  it("preserva estado intermediário estruturalmente válido para validar só no save", () => {
    const intermediate = [{ ...trigger, description: "" }];
    expect(parseSchemaDraft(rawDraft(intermediate))?.fields).toEqual(
      intermediate,
    );
  });

  it("rejeita valor fora do contrato estrutural", () => {
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(
      parseSchemaDraft(
        JSON.stringify({
          ...base,
          fields: [{ ...trigger, type: "tipo-inexistente" }],
        }),
      ),
    ).toBeNull();
  });

  it("rejeita JSON corrompido, formato antigo e revision inválida", () => {
    expect(parseSchemaDraft("{")).toBeNull();
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(
      parseSchemaDraft(JSON.stringify({ ...base, formatVersion: 1 })),
    ).toBeNull();
    expect(
      parseSchemaDraft(JSON.stringify({ ...base, revision: 0 })),
    ).toBeNull();
  });
});
