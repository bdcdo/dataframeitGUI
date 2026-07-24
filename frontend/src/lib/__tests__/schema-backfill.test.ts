import { describe, it, expect } from "vitest";
import {
  classifyLogEntries,
  reconstructSnapshotsByVersion,
  matchResponsesToVersions,
  type LogEntryRow,
  type EnrichedEntry,
  type ResponseRow,
} from "@/lib/schema-backfill";
import type { PydanticField } from "@/lib/types";

// Testes das funções puras extraídas de runBackfill (issue #392) — sem
// I/O, então não precisam do mock de Supabase usado por schema.test.ts.

function logRow(overrides: Partial<LogEntryRow>): LogEntryRow {
  return {
    id: "log1",
    field_name: "campo1",
    before_value: {},
    after_value: {},
    created_at: "2026-01-01T00:00:00.000Z",
    change_type: null,
    ...overrides,
  };
}

describe("classifyLogEntries", () => {
  it("log vazio retorna versão inicial 0.1.0", () => {
    const { enriched, finalVersion } = classifyLogEntries([]);
    expect(enriched).toEqual([]);
    expect(finalVersion).toEqual({ major: 0, minor: 1, patch: 0 });
  });

  it("adicionar campo (before vazio) é minor e acumula a versão", () => {
    const { enriched, finalVersion } = classifyLogEntries([
      logRow({
        id: "e1",
        before_value: {},
        after_value: { type: "text", description: "v1" },
      }),
    ]);
    expect(enriched[0].changeType).toBe("minor");
    expect(enriched[0].version).toEqual({ major: 0, minor: 2, patch: 0 });
    expect(finalVersion).toEqual({ major: 0, minor: 2, patch: 0 });
  });

  it("mudança só de description é patch", () => {
    const { enriched, finalVersion } = classifyLogEntries([
      logRow({
        id: "e1",
        before_value: { description: "antiga" },
        after_value: { description: "nova" },
      }),
    ]);
    expect(enriched[0].changeType).toBe("patch");
    expect(finalVersion).toEqual({ major: 0, minor: 1, patch: 1 });
  });

  it("change_type explícito 'major' vence a classificação estrutural, e a versão é cumulativa entre entries", () => {
    const { enriched, finalVersion } = classifyLogEntries([
      logRow({
        id: "e1",
        before_value: { description: "antiga" },
        after_value: { description: "nova" },
      }),
      logRow({
        id: "e2",
        before_value: { description: "nova" },
        after_value: { description: "nova2" },
        change_type: "major",
      }),
    ]);
    expect(enriched[0].version).toEqual({ major: 0, minor: 1, patch: 1 });
    expect(enriched[1].changeType).toBe("major");
    expect(enriched[1].version).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(finalVersion).toEqual({ major: 1, minor: 0, patch: 0 });
  });
});

describe("reconstructSnapshotsByVersion", () => {
  it("reverte add + patch e reconstrói os 3 snapshots intermediários", () => {
    const currentFields: PydanticField[] = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "campo1",
        type: "text",
        options: null,
        description: "v2",
      },
    ];

    const addEntry: EnrichedEntry = {
      id: "e1",
      field_name: "campo1",
      before: {},
      after: { type: "text", description: "v1" },
      createdAt: 1000,
      changeType: "minor",
      version: { major: 0, minor: 2, patch: 0 },
    };
    const patchEntry: EnrichedEntry = {
      id: "e2",
      field_name: "campo1",
      before: { description: "v1" },
      after: { description: "v2" },
      createdAt: 2000,
      changeType: "patch",
      version: { major: 0, minor: 2, patch: 1 },
    };

    const snapByVersion = reconstructSnapshotsByVersion(
      currentFields,
      [addEntry, patchEntry],
      { major: 0, minor: 2, patch: 1 },
    );

    expect(snapByVersion.get("0.2.1")?.get("campo1")?.description).toBe("v2");
    expect(snapByVersion.get("0.2.0")?.get("campo1")?.description).toBe("v1");
    expect(snapByVersion.get("0.1.0")?.has("campo1")).toBe(false);
  });

  it("sem entries, o único snapshot é o estado atual na versão inicial", () => {
    const currentFields: PydanticField[] = [
      {
        id: "00000000-0000-4000-8000-000000000002",
        name: "campo1",
        type: "text",
        options: null,
        description: "v1",
      },
    ];
    const snapByVersion = reconstructSnapshotsByVersion(currentFields, [], {
      major: 0,
      minor: 1,
      patch: 0,
    });
    expect(snapByVersion.size).toBe(1);
    expect(snapByVersion.get("0.1.0")?.get("campo1")?.description).toBe("v1");
  });
});

describe("matchResponsesToVersions", () => {
  const hashesByVersion = new Map<string, Record<string, string>>([
    ["0.1.0", {}],
    ["0.2.0", { campo1: "hashA" }],
  ]);
  const enriched: EnrichedEntry[] = [
    {
      id: "e1",
      field_name: "campo1",
      before: {},
      after: {},
      createdAt: 1000,
      changeType: "minor",
      version: { major: 0, minor: 2, patch: 0 },
    },
  ];

  function responseRow(overrides: Partial<ResponseRow>): ResponseRow {
    return {
      id: "r1",
      created_at: "1970-01-01T00:00:00.000Z",
      answer_field_hashes: null,
      version_inferred_from: null,
      ...overrides,
    };
  }

  it("preserva live_save sem incluir no bucket de updates", () => {
    const { updates, byMethod } = matchResponsesToVersions(
      [responseRow({ id: "r1", version_inferred_from: "live_save" })],
      hashesByVersion,
      enriched,
    );
    expect(updates.size).toBe(0);
    expect(byMethod.live_save).toBe(1);
  });

  it("resposta com hash batendo exatamente escolhe a versão por hash", () => {
    const { updates, byMethod } = matchResponsesToVersions(
      [
        responseRow({
          id: "r1",
          created_at: "1970-01-01T00:00:02.000Z",
          answer_field_hashes: { campo1: "hashA" },
        }),
      ],
      hashesByVersion,
      enriched,
    );
    const bucket = updates.get("0.2.0|hashes");
    expect(bucket?.ids).toEqual(["r1"]);
    expect(byMethod.hashes).toBe(1);
  });

  it("sem hash, cai para o fallback por created_at (versão mais recente <= ts)", () => {
    const { updates, byMethod } = matchResponsesToVersions(
      [responseRow({ id: "r2", created_at: "1970-01-01T00:00:00.500Z" })],
      hashesByVersion,
      enriched,
    );
    const bucket = updates.get("0.1.0|created_at");
    expect(bucket?.ids).toEqual(["r2"]);
    expect(byMethod.created_at).toBe(1);
  });

  it("hash presente mas sem nenhuma correspondência cai para fallback_created_at", () => {
    const { updates, byMethod } = matchResponsesToVersions(
      [
        responseRow({
          id: "r3",
          created_at: "1970-01-01T00:00:03.000Z",
          answer_field_hashes: { campo1: "hashErrado" },
        }),
      ],
      hashesByVersion,
      enriched,
    );
    const bucket = updates.get("0.2.0|fallback_created_at");
    expect(bucket?.ids).toEqual(["r3"]);
    expect(byMethod.fallback_created_at).toBe(1);
  });

  it("sem versão estruturalmente compatível usa o fallback temporal global", () => {
    const { updates, byMethod } = matchResponsesToVersions(
      [
        responseRow({
          id: "r-sem-candidato",
          created_at: "1970-01-01T00:00:03.000Z",
          answer_field_hashes: { campoInexistente: null },
        }),
      ],
      hashesByVersion,
      enriched,
    );

    expect(updates.get("0.2.0|fallback_created_at")?.ids).toEqual(["r-sem-candidato"]);
    expect(byMethod.fallback_created_at).toBe(1);
  });

  it("usa chave null como evidência estrutural e hash conhecido na pontuação", () => {
    const versions = new Map<string, Record<string, string>>([
      ["0.1.0", { conhecido: "hashB" }],
      ["0.2.0", { conhecido: "hashB", posterior: "hashC" }],
    ]);
    const { updates, byMethod } = matchResponsesToVersions(
      [
        responseRow({
          id: "r4",
          created_at: "1970-01-01T00:00:02.000Z",
          answer_field_hashes: { posterior: null, conhecido: "hashB" },
        }),
      ],
      versions,
      enriched,
    );

    expect(updates.get("0.2.0|hashes")?.ids).toEqual(["r4"]);
    expect(byMethod.hashes).toBe(1);
  });

  it("mapa apenas com null restringe a versões em que o campo existia", () => {
    const { updates, byMethod } = matchResponsesToVersions(
      [
        responseRow({
          id: "r5",
          created_at: "1970-01-01T00:00:00.500Z",
          answer_field_hashes: { campo1: null },
        }),
      ],
      hashesByVersion,
      enriched,
    );

    expect(updates.get("0.2.0|fallback_created_at")?.ids).toEqual(["r5"]);
    expect(byMethod.created_at).toBe(0);
    expect(byMethod.fallback_created_at).toBe(1);
  });

  it("mapa vazio continua legacy e usa created_at sem restrição estrutural", () => {
    const { updates, byMethod } = matchResponsesToVersions(
      [
        responseRow({
          id: "r6",
          created_at: "1970-01-01T00:00:00.500Z",
          answer_field_hashes: {},
        }),
      ],
      hashesByVersion,
      enriched,
    );

    expect(updates.get("0.1.0|created_at")?.ids).toEqual(["r6"]);
    expect(byMethod.created_at).toBe(1);
    expect(byMethod.fallback_created_at).toBe(0);
  });
});
