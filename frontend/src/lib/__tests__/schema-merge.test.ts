import { describe, expect, it } from "vitest";
import { mergeSchemas, unresolvedSchemaConflicts } from "@/lib/schema-merge";
import type { PydanticField } from "@/lib/types";

const q1: PydanticField = {
  name: "q1",
  type: "text",
  options: null,
  description: "Pergunta 1",
};
const q2: PydanticField = {
  name: "q2",
  type: "single",
  options: ["Sim", "Não"],
  description: "Pergunta 2",
};
const q3: PydanticField = {
  name: "q3",
  type: "date",
  options: null,
  description: "Pergunta 3",
};
const q4: PydanticField = {
  ...q1,
  name: "q4",
  description: "Pergunta 4",
};

describe("mergeSchemas", () => {
  it("mescla automaticamente propriedades alteradas em lados diferentes", () => {
    const result = mergeSchemas(
      [q1],
      [{ ...q1, description: "Descrição local" }],
      [{ ...q1, help_text: "Ajuda remota" }],
    );

    expect(result.conflicts).toEqual([]);
    expect(result.fields).toEqual([
      { ...q1, description: "Descrição local", help_text: "Ajuda remota" },
    ]);
  });

  it("expõe colisão na mesma propriedade e usa remoto apenas no preview", () => {
    const initial = mergeSchemas(
      [q1],
      [{ ...q1, description: "Local" }],
      [{ ...q1, description: "Remota" }],
    );
    const conflict = initial.conflicts[0];

    expect(conflict).toMatchObject({
      kind: "property",
      fieldName: "q1",
      property: "description",
      resolution: null,
    });
    expect(initial.fields[0].description).toBe("Remota");
    expect(unresolvedSchemaConflicts(initial).map(({ id }) => id)).toEqual([
      conflict.id,
    ]);

    const resolved = mergeSchemas(
      [q1],
      [{ ...q1, description: "Local" }],
      [{ ...q1, description: "Remota" }],
      { [conflict.id]: "local" },
    );
    expect(resolved.fields[0].description).toBe("Local");
    expect(unresolvedSchemaConflicts(resolved)).toEqual([]);
  });

  it("mescla adições independentes e mantém as locais na ordem local", () => {
    const localA = { ...q2, name: "local-a" };
    const localB = { ...q3, name: "local-b" };
    const remoteOnly = { ...q2, name: "remote" };
    const result = mergeSchemas(
      [q1],
      [q1, localB, localA],
      [q1, remoteOnly],
    );

    expect(result.conflicts).toEqual([]);
    expect(result.fields.map(({ name }) => name)).toEqual([
      "q1",
      "remote",
      "local-b",
      "local-a",
    ]);
  });

  it("preserva simultaneamente a posição de adições locais e remotas", () => {
    const a = { ...q1, name: "a" };
    const b = { ...q2, name: "b" };
    const x = { ...q3, name: "x" };
    const y = { ...q3, name: "y" };

    const result = mergeSchemas([a, b], [x, a, b], [a, b, y]);

    expect(result.conflicts).toEqual([]);
    expect(result.fields.map(({ name }) => name)).toEqual(["x", "a", "b", "y"]);
  });

  it("expõe adição concorrente do mesmo nome", () => {
    const result = mergeSchemas(
      [q1],
      [q1, { ...q2, description: "Local" }],
      [q1, { ...q2, description: "Remota" }],
    );

    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ kind: "field", reason: "add-add", fieldName: "q2" }),
    );
    expect(result.fields.find(({ name }) => name === "q2")?.description).toBe("Remota");
  });

  it.each([
    {
      label: "exclusão local contra edição remota",
      local: [] as PydanticField[],
      remote: [{ ...q1, description: "Remota" }],
      reason: "delete-edit",
    },
    {
      label: "edição local contra exclusão remota",
      local: [{ ...q1, description: "Local" }],
      remote: [] as PydanticField[],
      reason: "edit-delete",
    },
  ])("expõe $label", ({ local, remote, reason }) => {
    const result = mergeSchemas([q1], local, remote);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ kind: "field", reason, fieldName: "q1" }),
    );
  });

  it("interpreta rename como exclusão e adição, sem identidade implícita", () => {
    const renamed = { ...q1, name: "renamed" };
    const remote = { ...q1, description: "Remota" };
    const result = mergeSchemas([q1], [renamed], [remote]);

    expect(result.fields.map(({ name }) => name)).toContain("renamed");
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ kind: "field", reason: "delete-edit", fieldName: "q1" }),
    );
  });

  it("aplica reorder unilateral automaticamente", () => {
    const result = mergeSchemas([q1, q2, q3], [q3, q1, q2], [q1, q2, q3]);
    expect(result.conflicts).toEqual([]);
    expect(result.fields.map(({ name }) => name)).toEqual(["q3", "q1", "q2"]);
  });

  it("combina reorders independentes sem criar falso conflito", () => {
    const result = mergeSchemas(
      [q1, q2, q3, q4],
      [q2, q1, q3, q4],
      [q1, q2, q4, q3],
    );

    expect(result.conflicts).toEqual([]);
    expect(result.fields.map(({ name }) => name)).toEqual(["q2", "q1", "q4", "q3"]);
  });

  it("expõe reorder incompatível e permite escolher a ordem local", () => {
    const initial = mergeSchemas([q1, q2, q3], [q2, q1, q3], [q1, q3, q2]);
    expect(initial.conflicts).toContainEqual(
      expect.objectContaining({ id: "order", kind: "order", resolution: null }),
    );
    expect(initial.fields.map(({ name }) => name)).toEqual(["q1", "q3", "q2"]);

    const resolved = mergeSchemas(
      [q1, q2, q3],
      [q2, q1, q3],
      [q1, q3, q2],
      { order: "local" },
    );
    expect(resolved.fields.map(({ name }) => name)).toEqual(["q2", "q1", "q3"]);
  });
});
