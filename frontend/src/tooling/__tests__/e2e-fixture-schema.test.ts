import { describe, expect, it } from "vitest";

import { sameStoredFields } from "../../../scripts/e2e-fixtures/fixture-schema";

// O gerador da fixture `compare` só avança `schema_revision` quando os campos
// mudaram; o banco recusa avançar sem mudança (#738).
describe("sameStoredFields", () => {
  const fields = [
    { id: "f1", name: "q1", type: "single", options: ["a", "b"], help_text: undefined },
  ];

  it("campos iguais aos gravados, com as chaves noutra ordem e sem o undefined", () => {
    const stored = [{ type: "single", options: ["a", "b"], name: "q1", id: "f1" }];
    expect(sameStoredFields(stored, fields)).toBe(true);
  });

  it("qualquer mudança de conteúdo conta como mudança de schema", () => {
    expect(sameStoredFields([{ id: "f1", name: "q1", type: "single", options: ["a", "c"] }], fields)).toBe(false);
    expect(sameStoredFields([{ id: "f1", name: "q1", type: "single", options: ["b", "a"] }], fields)).toBe(false);
    expect(sameStoredFields([], fields)).toBe(false);
    expect(sameStoredFields(null, fields)).toBe(false);
  });
});
