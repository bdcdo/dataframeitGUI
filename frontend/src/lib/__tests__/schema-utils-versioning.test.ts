import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  computeFieldHash,
  classifyChange,
  bumpVersion,
  snapshotOf,
  diffFields,
  fieldDiffIsStructural,
  generatePydanticCode,
  stableStringify,
} from "@/lib/schema-utils";
import type { FieldCondition, PydanticField } from "@/lib/types";

const baseField = (over: Partial<PydanticField>): PydanticField => ({
  name: "x",
  type: "single",
  description: "x",
  options: null,
  ...over,
});

// Reproduz a fórmula de content do computeFieldHash (e do _field_hash do
// backend) para validar a implementação de SHA-256 em TS puro contra o
// crypto do Node.
function expectedHash(
  name: string,
  type: string,
  options: string[] | null,
  description: string,
): string {
  const optionsPart = options
    ? "[" +
      options
        .toSorted()
        .map((s) => `'${s}'`)
        .join(", ") +
      "]"
    : "";
  const content = `${name}|${type}|${optionsPart}|${description}`;
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

describe("computeFieldHash", () => {
  it("matches Node crypto SHA-256 for a plain field", () => {
    expect(computeFieldHash("topic", "single", ["a", "b"], "Desc")).toBe(
      expectedHash("topic", "single", ["a", "b"], "Desc"),
    );
  });

  it("matches for null options", () => {
    expect(computeFieldHash("note", "text", null, "Free text")).toBe(
      expectedHash("note", "text", null, "Free text"),
    );
  });

  it("matches for unicode descriptions and option ordering", () => {
    expect(
      computeFieldHash("q", "multi", ["Não", "Sim"], "Houve provimento? ção"),
    ).toBe(expectedHash("q", "multi", ["Não", "Sim"], "Houve provimento? ção"));
    // options são ordenados antes do hash — ordem de entrada não importa
    expect(computeFieldHash("q", "multi", ["Sim", "Não"], "d")).toBe(
      computeFieldHash("q", "multi", ["Não", "Sim"], "d"),
    );
  });

  it("excludes target/condition/help_text from the hash", () => {
    const h1 = computeFieldHash("q", "single", ["a"], "d");
    // mesmo name/type/options/description -> mesmo hash
    expect(computeFieldHash("q", "single", ["a"], "d")).toBe(h1);
  });
});

describe("classifyChange", () => {
  it("returns null when nothing changed", () => {
    const f = [baseField({ name: "q1", options: ["A"] })];
    expect(classifyChange(f, f)).toBeNull();
  });

  it("returns minor on add/remove field", () => {
    const oldF = [baseField({ name: "q1", options: ["A"] })];
    const newF = [
      baseField({ name: "q1", options: ["A"] }),
      baseField({ name: "q2", type: "text" }),
    ];
    expect(classifyChange(oldF, newF)).toBe("minor");
  });

  it("returns minor on target change", () => {
    const oldF = [baseField({ name: "q1", options: ["A"] })];
    const newF = [baseField({ name: "q1", options: ["A"], target: "llm_only" })];
    expect(classifyChange(oldF, newF)).toBe("minor");
  });

  it("returns patch on description change", () => {
    const oldF = [baseField({ name: "q1", options: ["A"], description: "a" })];
    const newF = [baseField({ name: "q1", options: ["A"], description: "b" })];
    expect(classifyChange(oldF, newF)).toBe("patch");
  });

  it("returns patch on justification_prompt change", () => {
    const oldF = [baseField({ name: "q1", options: ["A"] })];
    const newF = [
      baseField({ name: "q1", options: ["A"], justification_prompt: "cite o trecho" }),
    ];
    expect(classifyChange(oldF, newF)).toBe("patch");
  });
});

// O jsonb do Postgres normaliza a ordem das chaves; condition/subfields lidos
// do banco voltam com chaves reordenadas em relação ao objeto autorado no
// cliente. As comparações precisam ser insensíveis a isso.
describe("stableStringify (round-trip jsonb)", () => {
  // Mesma condição com as chaves em ordens opostas, como o jsonb devolveria.
  const condA = { field: "q0", equals: "Sim" } as FieldCondition;
  const condB = JSON.parse('{"equals":"Sim","field":"q0"}') as FieldCondition;

  it("é insensível à ordem das chaves, inclusive aninhadas", () => {
    expect(stableStringify(condA)).toBe(stableStringify(condB));
    expect(
      stableStringify([{ key: "a", label: "A" }, { label: "B", key: "b" }]),
    ).toBe(stableStringify([{ label: "A", key: "a" }, { key: "b", label: "B" }]));
  });

  it("distingue valores realmente diferentes e omite undefined", () => {
    expect(stableStringify({ field: "q0", equals: "Sim" })).not.toBe(
      stableStringify({ field: "q0", equals: "Não" }),
    );
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it("classifyChange retorna null para condition idêntica com chaves reordenadas", () => {
    const oldF = [baseField({ name: "q1", options: ["A"], condition: condB })];
    const newF = [baseField({ name: "q1", options: ["A"], condition: condA })];
    expect(classifyChange(oldF, newF)).toBeNull();
    expect(diffFields(oldF, newF)).toHaveLength(0);
  });

  it("classifyChange segue minor para mudança real de condition", () => {
    const oldF = [baseField({ name: "q1", options: ["A"], condition: condA })];
    const newF = [
      baseField({
        name: "q1",
        options: ["A"],
        condition: { field: "q0", equals: "Não" },
      }),
    ];
    expect(classifyChange(oldF, newF)).toBe("minor");
    const entries = diffFields(oldF, newF);
    expect(entries).toHaveLength(1);
    expect(entries[0].change_summary).toContain("condição");
  });

  it("fieldDiffIsStructural ignora reordenação de chaves em condition", () => {
    expect(fieldDiffIsStructural({ condition: condA }, { condition: condB })).toBe(
      false,
    );
  });
});

describe("bumpVersion", () => {
  it("bumps each level and resets lower ones", () => {
    expect(bumpVersion({ major: 1, minor: 2, patch: 3 }, "major")).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
    });
    expect(bumpVersion({ major: 1, minor: 2, patch: 3 }, "minor")).toEqual({
      major: 1,
      minor: 3,
      patch: 0,
    });
    expect(bumpVersion({ major: 1, minor: 2, patch: 3 }, "patch")).toEqual({
      major: 1,
      minor: 2,
      patch: 4,
    });
  });
});

describe("snapshotOf", () => {
  it("includes justification_prompt and all properties", () => {
    const snap = snapshotOf(
      baseField({
        name: "q1",
        options: ["A"],
        justification_prompt: "cite o trecho",
        target: "llm_only",
      }),
    );
    expect(snap.justification_prompt).toBe("cite o trecho");
    expect(snap.target).toBe("llm_only");
    expect(snap).toHaveProperty("condition");
    expect(snap).toHaveProperty("subfields");
  });
});

describe("diffFields", () => {
  it("emits added / removed entries", () => {
    const oldF = [baseField({ name: "q1", options: ["A"] })];
    const newF = [baseField({ name: "q2", type: "text" })];
    const entries = diffFields(oldF, newF);
    const summaries = entries.map((e) => `${e.field_name}:${e.change_summary}`);
    expect(summaries).toContain("q2:campo adicionado");
    expect(summaries).toContain("q1:campo removido");
  });

  it("emits a justification_prompt diff entry", () => {
    const oldF = [baseField({ name: "q1", options: ["A"] })];
    const newF = [
      baseField({ name: "q1", options: ["A"], justification_prompt: "novo" }),
    ];
    const entries = diffFields(oldF, newF);
    expect(entries).toHaveLength(1);
    expect(entries[0].change_summary).toContain("prompt de justificativa");
    expect(entries[0].after_value.justification_prompt).toBe("novo");
  });
});

describe("fieldDiffIsStructural", () => {
  it("treats target change as structural", () => {
    expect(
      fieldDiffIsStructural({ target: "all" }, { target: "llm_only" }),
    ).toBe(true);
  });

  it("treats justification_prompt change as textual (patch)", () => {
    expect(
      fieldDiffIsStructural(
        { justification_prompt: "a" },
        { justification_prompt: "b" },
      ),
    ).toBe(false);
  });
});

describe("generatePydanticCode round-trip surface", () => {
  it("emits justification_prompt in json_schema_extra", () => {
    const code = generatePydanticCode([
      baseField({
        name: "q1",
        options: ["A", "B"],
        justification_prompt: "Cite o trecho do parecer.",
      }),
    ]);
    expect(code).toContain(
      '"justification_prompt": "Cite o trecho do parecer."',
    );
  });
});
