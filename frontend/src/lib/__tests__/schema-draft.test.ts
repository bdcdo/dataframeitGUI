import { describe, expect, it } from "vitest";
import {
  SCHEMA_DRAFT_FORMAT_VERSION,
  parseSchemaDraft,
  readSchemaDraft,
} from "@/lib/schema-draft";
import { PYDANTIC_FIELD_PROPERTY_KEYS } from "@/lib/pydantic-field";
import { snapshotOf } from "@/lib/schema-utils";
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
    writeToken: "write-1",
    base: { fields: [trigger], version: "0.1.0", revision: 4 },
    fields,
  });
}

describe("readSchemaDraft", () => {
  it("reconhece o envelope legível", () => {
    expect(readSchemaDraft(rawDraft()).kind).toBe("draft");
  });

  it("distingue envelope de formato anterior de slot vazio", () => {
    // A distinção é o que permite avisar em vez de apagar calado: os dois casos
    // liberam o slot, mas só um deles perdeu trabalho do usuário.
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(
      readSchemaDraft(JSON.stringify({ ...base, formatVersion: 2 })),
    ).toEqual({ kind: "stale-format", formatVersion: 2 });

    expect(readSchemaDraft(null)).toEqual({ kind: "empty" });
    expect(readSchemaDraft("{")).toEqual({ kind: "empty" });
    // Sem marcador de formato não é envelope nosso: nada foi perdido.
    expect(readSchemaDraft(JSON.stringify({ foo: 1 }))).toEqual({ kind: "empty" });
  });

  it("trata envelope do formato corrente porém corrompido como ilegível, não como vazio", () => {
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(readSchemaDraft(JSON.stringify({ ...base, writeToken: "" }))).toEqual({
      kind: "stale-format",
      formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
    });
  });

  it("cede o slot a um envelope de formato mais novo", () => {
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(
      readSchemaDraft(
        JSON.stringify({ ...base, formatVersion: SCHEMA_DRAFT_FORMAT_VERSION + 1 }),
      ),
    ).toEqual({
      kind: "newer-format",
      formatVersion: SCHEMA_DRAFT_FORMAT_VERSION + 1,
    });
  });
});

describe("parseSchemaDraft", () => {
  it("mantém o schema Zod alinhado ao snapshot canônico mais hash derivado", () => {
    expect(PYDANTIC_FIELD_PROPERTY_KEYS).toEqual(
      [...Object.keys(snapshotOf(complete)), "hash"].sort(),
    );
  });

  it("aceita envelope v4 com baseline completo e todas as propriedades", () => {
    expect(parseSchemaDraft(rawDraft())).toEqual({
      formatVersion: 4,
      writeToken: "write-1",
      base: { fields: [trigger], version: "0.1.0", revision: 4 },
      fields: [trigger, complete],
    });
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
        fields: [
          trigger,
          {
            ...complete,
            subfields: [{ ...complete.subfields![0], extra: true }],
          },
        ],
      },
    ],
    [
      "condição",
      {
        fields: [
          trigger,
          {
            ...complete,
            condition: { field: "gatilho", equals: "Sim", extra: true },
          },
        ],
      },
    ],
    ["baseline", { base: { fields: [trigger], version: "0.1.0", revision: 4, extra: true } }],
  ])("rejeita chave desconhecida no %s", (_label, override) => {
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(parseSchemaDraft(JSON.stringify({ ...base, ...override }))).toBeNull();
  });

  it("preserva estado intermediário estruturalmente válido", () => {
    const intermediate = [{ ...trigger, description: "" }];
    expect(parseSchemaDraft(rawDraft(intermediate))?.fields).toEqual(intermediate);
  });

  it("rejeita nomes de campo duplicados no rascunho", () => {
    expect(
      parseSchemaDraft(
        rawDraft([trigger, { ...trigger, description: "Duplicado" }]),
      ),
    ).toBeNull();
  });

  it("rejeita JSON corrompido, formato antigo, token vazio e revisão inválida", () => {
    expect(parseSchemaDraft("{")).toBeNull();
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(
      parseSchemaDraft(JSON.stringify({ ...base, formatVersion: 2 })),
    ).toBeNull();
    expect(parseSchemaDraft(JSON.stringify({ ...base, writeToken: "" }))).toBeNull();
    expect(
      parseSchemaDraft(
        JSON.stringify({
          ...base,
          base: { fields: [trigger], version: "0.1.0", revision: -1 },
        }),
      ),
    ).toBeNull();
  });
});
