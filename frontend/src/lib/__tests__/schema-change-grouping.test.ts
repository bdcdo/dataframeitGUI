import { describe, expect, it } from "vitest";
import { groupChangesByCommit } from "../schema-change-grouping";
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
