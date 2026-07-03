import { describe, expect, it } from "vitest";
import { detectFieldChangeKind, diffPydanticField } from "../schema-change-diff";
import type { SchemaChangeEntry } from "../types";

function makeEntry(overrides: Partial<SchemaChangeEntry> = {}): SchemaChangeEntry {
  return {
    id: overrides.id ?? "id-1",
    fieldName: overrides.fieldName ?? "campo_x",
    changeSummary: overrides.changeSummary ?? "edit",
    beforeValue: overrides.beforeValue ?? { name: "campo_x", description: "antes" },
    afterValue: overrides.afterValue ?? { name: "campo_x", description: "depois" },
    changedBy: overrides.changedBy ?? "Alice",
    userId: overrides.userId ?? "user-1",
    createdAt: overrides.createdAt ?? "2026-05-04T10:00:00Z",
    changeType: overrides.changeType ?? "minor",
    version: overrides.version ?? { major: 0, minor: 2, patch: 0 },
  };
}

describe("detectFieldChangeKind", () => {
  it("retorna added quando before é vazio", () => {
    expect(
      detectFieldChangeKind(
        makeEntry({ beforeValue: {}, afterValue: { name: "x" } }),
      ),
    ).toBe("added");
  });

  it("retorna removed quando after é vazio", () => {
    expect(
      detectFieldChangeKind(
        makeEntry({ beforeValue: { name: "x" }, afterValue: {} }),
      ),
    ).toBe("removed");
  });

  it("retorna renamed quando o nome muda", () => {
    expect(
      detectFieldChangeKind(
        makeEntry({
          beforeValue: { name: "antigo" },
          afterValue: { name: "novo" },
        }),
      ),
    ).toBe("renamed");
  });

  it("retorna modified caso contrário", () => {
    expect(
      detectFieldChangeKind(
        makeEntry({
          beforeValue: { name: "x", description: "a" },
          afterValue: { name: "x", description: "b" },
        }),
      ),
    ).toBe("modified");
  });
});

describe("diffPydanticField", () => {
  it("não retorna diffs quando before === after", () => {
    const v = { name: "x", description: "d", required: true };
    expect(diffPydanticField(v, v)).toEqual([]);
  });

  it("captura mudança de description", () => {
    const diffs = diffPydanticField(
      { description: "antes" },
      { description: "depois" },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ property: "description", before: "antes", after: "depois" });
  });

  it("captura mudança de required (booleana)", () => {
    const diffs = diffPydanticField({ required: false }, { required: true });
    expect(diffs).toEqual([
      { property: "required", before: false, after: true },
    ]);
  });

  it("captura mudança de options (ordem importa via arraysEqual)", () => {
    const diffs = diffPydanticField(
      { options: ["a", "b"] },
      { options: ["a", "b", "c"] },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].property).toBe("options");
    expect(diffs[0].after).toEqual(["a", "b", "c"]);
  });

  it("não duplica diff quando help_text é null vs undefined", () => {
    const diffs = diffPydanticField(
      { help_text: null },
      { help_text: undefined },
    );
    expect(diffs).toEqual([]);
  });

  it("captura mudança de subfields", () => {
    const diffs = diffPydanticField(
      { subfields: [{ key: "a", label: "A", required: true }] },
      { subfields: [{ key: "a", label: "A", required: false }] },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].property).toBe("subfields");
  });

  // O jsonb do Postgres normaliza a ordem das chaves; before/after lidos do
  // banco podem vir com subfields/condition reordenados em relação ao que
  // foi autorado no cliente. subfieldsEqual/conditionEqual usam
  // stableStringify (não JSON.stringify) por isso — mesma correção de
  // schema-utils.ts (classifyChange/diffFields), ver PR #352.
  it("não reporta mudança de subfields quando só a ordem das chaves difere (round-trip jsonb)", () => {
    const diffs = diffPydanticField(
      { subfields: [JSON.parse('{"required":true,"key":"a","label":"A"}')] },
      { subfields: [{ key: "a", label: "A", required: true }] },
    );
    expect(diffs).toHaveLength(0);
  });

  it("não reporta mudança de condition quando só a ordem das chaves difere (round-trip jsonb)", () => {
    const diffs = diffPydanticField(
      { condition: JSON.parse('{"equals":"a","field":"x"}') },
      { condition: { field: "x", equals: "a" } },
    );
    expect(diffs).toHaveLength(0);
  });

  it("captura propriedades novas no SubfieldDef futuro (futureproof)", () => {
    // Simula a adição futura de uma prop nova como `description` em SubfieldDef.
    const diffs = diffPydanticField(
      { subfields: [{ key: "a", label: "A", description: "old" }] },
      { subfields: [{ key: "a", label: "A", description: "new" }] },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].property).toBe("subfields");
  });

  it("captura mudança de condition", () => {
    const diffs = diffPydanticField(
      { condition: { field: "x", equals: "a" } },
      { condition: { field: "x", equals: "b" } },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].property).toBe("condition");
  });

  it("captura múltiplas mudanças simultâneas", () => {
    const diffs = diffPydanticField(
      { name: "a", description: "x", required: false },
      { name: "b", description: "y", required: true },
    );
    expect(diffs.map((d) => d.property).sort()).toEqual([
      "description",
      "name",
      "required",
    ]);
  });
});
