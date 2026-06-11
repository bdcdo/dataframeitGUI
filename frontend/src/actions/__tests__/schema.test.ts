import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PydanticField } from "@/lib/types";

// Testes do conserto da #178: o UPDATE de projects filtrado pela RLS retorna
// sucesso com 0 linhas no PostgREST — antes, saveSchemaFromGUI seguia em
// frente e inseria entradas em schema_change_log, gerando histórico fantasma.
// O mock segue o padrão de members.test.ts: builder chainable + thenable, com
// fila de resultados por tabela consumida na ordem das queries.

type WriteCall = { table: string; op: string; payload: unknown };
let writeCalls: WriteCall[];

type TableResult = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
};

function makeClient(tableResults?: Record<string, TableResult | TableResult[]>) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["eq", "is", "in", "neq", "match", "select", "single", "maybeSingle", "order", "limit"]) {
        builder[m] = () => builder;
      }
      builder.update = (payload: unknown) => {
        writeCalls.push({ table, op: "update", payload });
        return builder;
      };
      builder.insert = (payload: unknown) => {
        writeCalls.push({ table, op: "insert", payload });
        return builder;
      };
      builder.delete = () => {
        writeCalls.push({ table, op: "delete", payload: null });
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) => {
        const entry = tableResults?.[table];
        const fixed = Array.isArray(entry) ? entry.shift() : entry;
        return resolve({
          data: fixed?.data ?? null,
          error: fixed?.error ?? null,
        });
      };
      return builder;
    },
  };
}

let serverTableResults: Record<string, TableResult | TableResult[]> | undefined;

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "userCoord" }),
}));
vi.mock("@/lib/api", () => ({
  fetchFastAPI: async () => ({ valid: true, fields: [], model_name: null, errors: [] }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeClient(serverTableResults),
}));

import {
  saveSchemaFromGUI,
  savePrompt,
  publishMajorVersion,
  saveLlmConfig,
} from "../schema";

const FIELD: PydanticField = {
  name: "q1",
  type: "text",
  options: null,
  description: "Pergunta 1",
};

// Estado prévio do projeto lido por saveSchemaFromGUI (schema vazio, v0.1.0).
const PROJECT_SELECT: TableResult = {
  data: {
    pydantic_fields: [],
    schema_version_major: 0,
    schema_version_minor: 1,
    schema_version_patch: 0,
  },
};

beforeEach(() => {
  writeCalls = [];
  serverTableResults = undefined;
});

describe("saveSchemaFromGUI", () => {
  it("o caso da #178: UPDATE de projects filtrado (0 linhas) rejeita e NÃO grava histórico fantasma", async () => {
    serverTableResults = {
      projects: [PROJECT_SELECT, { data: [] }],
    };

    await expect(saveSchemaFromGUI("p1", [FIELD])).rejects.toThrow(/sem permissão/i);

    const logInserts = writeCalls.filter(
      (c) => c.table === "schema_change_log" && c.op === "insert",
    );
    expect(logInserts).toHaveLength(0);
  });

  it("caminho feliz: update de projects confirmado antes do insert do log, com versão bumpada", async () => {
    serverTableResults = {
      projects: [PROJECT_SELECT, { data: [{ id: "p1" }] }],
      schema_change_log: { data: null, error: null },
    };

    await expect(saveSchemaFromGUI("p1", [FIELD])).resolves.toBeUndefined();

    const ops = writeCalls.map((c) => `${c.table}:${c.op}`);
    expect(ops.indexOf("projects:update")).toBeLessThan(
      ops.indexOf("schema_change_log:insert"),
    );

    const logInsert = writeCalls.find(
      (c) => c.table === "schema_change_log" && c.op === "insert",
    );
    const entries = logInsert?.payload as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    // Campo adicionado = mudança estrutural → MINOR (0.1.0 → 0.2.0)
    expect(entries[0]).toMatchObject({
      project_id: "p1",
      changed_by: "userCoord",
      field_name: "q1",
      change_type: "minor",
      version_major: 0,
      version_minor: 2,
      version_patch: 0,
    });
  });

  it("erro no insert do log rejeita com mensagem de histórico (schema já salvo)", async () => {
    serverTableResults = {
      projects: [PROJECT_SELECT, { data: [{ id: "p1" }] }],
      schema_change_log: { data: null, error: { message: "log boom" } },
    };

    await expect(saveSchemaFromGUI("p1", [FIELD])).rejects.toThrow(/histórico.*log boom/);
    // O update de projects aconteceu antes da falha do log.
    expect(writeCalls.some((c) => c.table === "projects" && c.op === "update")).toBe(true);
  });
});

describe("publishMajorVersion", () => {
  it("0 linhas no bump rejeita e não grava entrada MAJOR fantasma", async () => {
    serverTableResults = {
      projects: [
        { data: { schema_version_major: 0, schema_version_minor: 18, schema_version_patch: 0 } },
        { data: [] },
      ],
    };

    await expect(publishMajorVersion("p1")).rejects.toThrow(/sem permissão/i);
    expect(
      writeCalls.filter((c) => c.table === "schema_change_log" && c.op === "insert"),
    ).toHaveLength(0);
  });
});

describe("savePrompt / saveLlmConfig", () => {
  it("savePrompt rejeita em 0 linhas com a copy específica", async () => {
    serverTableResults = { projects: { data: [] } };
    await expect(savePrompt("p1", "novo prompt")).rejects.toThrow(
      /Não foi possível salvar o prompt/,
    );
  });

  it("saveLlmConfig rejeita em 0 linhas com a copy específica", async () => {
    serverTableResults = { projects: { data: [] } };
    await expect(
      saveLlmConfig("p1", { llm_provider: "google", llm_model: "gemini", llm_kwargs: {} }),
    ).rejects.toThrow(/configuração do LLM/);
  });
});
