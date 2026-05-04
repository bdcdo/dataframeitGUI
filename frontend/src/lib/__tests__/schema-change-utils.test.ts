import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  detectFieldChangeKind,
  diffPydanticField,
  formatCondition,
  formatRelativeDate,
  formatTarget,
  formatType,
  formatVersion,
  groupChangesByCommit,
  propertyLabel,
} from "../schema-change-utils";
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

  it("captura mudança de subfields via JSON.stringify", () => {
    const diffs = diffPydanticField(
      { subfields: [{ key: "a", label: "A", required: true }] },
      { subfields: [{ key: "a", label: "A", required: false }] },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].property).toBe("subfields");
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

describe("groupChangesByCommit", () => {
  it("agrupa entries do mesmo userId dentro da janela de 5s", () => {
    const e1 = makeEntry({ id: "1", createdAt: "2026-05-04T10:00:00Z" });
    const e2 = makeEntry({ id: "2", createdAt: "2026-05-04T10:00:03Z" });
    const groups = groupChangesByCommit([e1, e2]);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toHaveLength(2);
  });

  it("separa por userId mesmo dentro da janela", () => {
    const e1 = makeEntry({ id: "1", userId: "user-1", createdAt: "2026-05-04T10:00:00Z" });
    const e2 = makeEntry({ id: "2", userId: "user-2", createdAt: "2026-05-04T10:00:01Z" });
    const groups = groupChangesByCommit([e1, e2]);
    expect(groups).toHaveLength(2);
  });

  it("usa janela deslizante: agrega 6 mudanças com gap de 4s cada", () => {
    // sequência de 6 mudanças, separadas por 4s — fora da janela head-fixa, dentro da deslizante
    const entries = Array.from({ length: 6 }, (_, i) =>
      makeEntry({
        id: `id-${i}`,
        createdAt: new Date(Date.UTC(2026, 4, 4, 10, 0, i * 4)).toISOString(),
      }),
    );
    const groups = groupChangesByCommit(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toHaveLength(6);
  });

  it("quebra grupo quando gap entre últimas duas excede 5s", () => {
    const e1 = makeEntry({ id: "1", createdAt: "2026-05-04T10:00:00Z" });
    const e2 = makeEntry({ id: "2", createdAt: "2026-05-04T10:00:10Z" });
    const groups = groupChangesByCommit([e1, e2]);
    expect(groups).toHaveLength(2);
  });

  it("separa por versão diferente", () => {
    const e1 = makeEntry({
      id: "1",
      createdAt: "2026-05-04T10:00:00Z",
      version: { major: 0, minor: 2, patch: 0 },
    });
    const e2 = makeEntry({
      id: "2",
      createdAt: "2026-05-04T10:00:01Z",
      version: { major: 0, minor: 1, patch: 0 },
    });
    const groups = groupChangesByCommit([e1, e2]);
    expect(groups).toHaveLength(2);
  });

  it("ordena entries em DESC dentro do retorno", () => {
    const e1 = makeEntry({ id: "old", createdAt: "2026-05-04T09:00:00Z" });
    const e2 = makeEntry({ id: "new", createdAt: "2026-05-04T11:00:00Z" });
    const groups = groupChangesByCommit([e1, e2]);
    expect(groups[0].entries[0].id).toBe("new");
  });
});

describe("formatCondition", () => {
  it("formata equals", () => {
    expect(formatCondition({ field: "x", equals: "a" })).toBe('x = "a"');
  });

  it("formata not_equals com número", () => {
    expect(formatCondition({ field: "x", not_equals: 5 })).toBe("x ≠ 5");
  });

  it("formata in", () => {
    expect(formatCondition({ field: "x", in: ["a", "b"] })).toBe('x ∈ ["a", "b"]');
  });

  it("formata not_in", () => {
    expect(formatCondition({ field: "x", not_in: [1, 2] })).toBe("x ∉ [1, 2]");
  });

  it("formata exists true/false", () => {
    expect(formatCondition({ field: "x", exists: true })).toBe("x existe");
    expect(formatCondition({ field: "x", exists: false })).toBe("x ausente");
  });

  it("retorna 'sem condição' para null/undefined", () => {
    expect(formatCondition(null)).toBe("sem condição");
    expect(formatCondition(undefined)).toBe("sem condição");
  });
});

describe("formatRelativeDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retorna 'agora' para diff < 60s", () => {
    expect(formatRelativeDate("2026-05-04T11:59:30Z")).toBe("agora");
  });

  it("retorna minutos para até 60min", () => {
    expect(formatRelativeDate("2026-05-04T11:55:00Z")).toBe("há 5 minutos");
    expect(formatRelativeDate("2026-05-04T11:59:00Z")).toBe("há 1 minuto");
  });

  it("retorna horas para até 24h", () => {
    expect(formatRelativeDate("2026-05-04T09:00:00Z")).toBe("há 3 horas");
    expect(formatRelativeDate("2026-05-04T11:00:00Z")).toBe("há 1 hora");
  });

  it("retorna 'ontem' para 1 dia", () => {
    expect(formatRelativeDate("2026-05-03T12:00:00Z")).toBe("ontem");
  });

  it("retorna 'há N dias' para 2-6 dias", () => {
    expect(formatRelativeDate("2026-05-01T12:00:00Z")).toBe("há 3 dias");
  });

  it("retorna data formatada para >= 7 dias", () => {
    const result = formatRelativeDate("2026-04-20T12:00:00Z");
    // toLocaleDateString pt-BR: "20/04/2026"
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });
});

describe("formatVersion / formatTarget / formatType / propertyLabel", () => {
  it("formatVersion", () => {
    expect(formatVersion(null)).toBe("—");
    expect(formatVersion({ major: 1, minor: 2, patch: 3 })).toBe("v1.2.3");
  });

  it("formatTarget cobre labels conhecidos e fallback", () => {
    expect(formatTarget("all")).toBe("Todos");
    expect(formatTarget("llm_only")).toBe("Só LLM");
    expect(formatTarget("desconhecido")).toBe("desconhecido");
    expect(formatTarget(null)).toBe("—");
  });

  it("formatType cobre labels conhecidos", () => {
    expect(formatType("single")).toBe("Escolha única");
    expect(formatType("multi")).toBe("Múltipla escolha");
    expect(formatType("text")).toBe("Texto");
    expect(formatType("date")).toBe("Data");
  });

  it("propertyLabel traduz cada propriedade", () => {
    expect(propertyLabel("name")).toBe("nome");
    expect(propertyLabel("description")).toBe("descrição");
    expect(propertyLabel("subfields")).toBe("subcampos");
    expect(propertyLabel("condition")).toBe("condição");
  });
});
