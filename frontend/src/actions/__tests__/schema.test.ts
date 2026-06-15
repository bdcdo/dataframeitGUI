import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PydanticField } from "@/lib/types";
import {
  makeSupabaseMock,
  type TableResult,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

// Testes do conserto da #178: o UPDATE de projects filtrado pela RLS retorna
// sucesso com 0 linhas no PostgREST — antes, saveSchemaFromGUI seguia em
// frente e inseria entradas em schema_change_log, gerando histórico fantasma.
// As actions retornam { error } (não lançam): o Next mascara a message de
// erros lançados em Server Actions em produção.

let writeCalls: WriteCall[];
let serverTableResults: TableResults | undefined;

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "userCoord" }),
}));
vi.mock("@/lib/api-server", () => ({
  fetchFastAPIServer: async () => ({ valid: true, fields: [], model_name: null, errors: [] }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({ tableResults: serverTableResults, writeCalls }),
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
  it("o caso da #178: UPDATE de projects filtrado (0 linhas) retorna erro e NÃO grava histórico fantasma", async () => {
    serverTableResults = {
      projects: [PROJECT_SELECT, { data: [] }],
    };

    const r = await saveSchemaFromGUI("p1", [FIELD]);
    expect(r.error).toMatch(/sem permissão/i);

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

    const r = await saveSchemaFromGUI("p1", [FIELD]);
    expect(r.error).toBeUndefined();

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

  it("erro no insert do log retorna erro com mensagem de histórico (schema já salvo)", async () => {
    serverTableResults = {
      projects: [PROJECT_SELECT, { data: [{ id: "p1" }] }],
      schema_change_log: { data: null, error: { message: "log boom" } },
    };

    const r = await saveSchemaFromGUI("p1", [FIELD]);
    expect(r.error).toMatch(/histórico.*log boom/);
    // O update de projects aconteceu antes da falha do log.
    expect(writeCalls.some((c) => c.table === "projects" && c.op === "update")).toBe(true);
  });
});

describe("publishMajorVersion", () => {
  it("0 linhas no bump retorna erro e não grava entrada MAJOR fantasma", async () => {
    serverTableResults = {
      projects: [
        { data: { schema_version_major: 0, schema_version_minor: 18, schema_version_patch: 0 } },
        { data: [] },
      ],
    };

    const r = await publishMajorVersion("p1");
    expect(r.error).toMatch(/sem permissão/i);
    expect(r.bumped).toBeUndefined();
    expect(
      writeCalls.filter((c) => c.table === "schema_change_log" && c.op === "insert"),
    ).toHaveLength(0);
  });

  it("falha parcial: MAJOR publicada mas log falhou → retorna bumped E erro", async () => {
    serverTableResults = {
      projects: [
        { data: { schema_version_major: 0, schema_version_minor: 18, schema_version_patch: 0 } },
        { data: [{ id: "p1" }] },
      ],
      schema_change_log: { data: null, error: { message: "log boom" } },
    };

    const r = await publishMajorVersion("p1");
    expect(r.bumped).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(r.error).toMatch(/MAJOR publicada.*log boom/);
  });

  it("caminho feliz: retorna a versão bumpada sem erro", async () => {
    serverTableResults = {
      projects: [
        { data: { schema_version_major: 0, schema_version_minor: 18, schema_version_patch: 0 } },
        { data: [{ id: "p1" }] },
      ],
      schema_change_log: { data: null, error: null },
    };

    const r = await publishMajorVersion("p1");
    expect(r.error).toBeUndefined();
    expect(r.bumped).toEqual({ major: 1, minor: 0, patch: 0 });
  });
});

describe("savePrompt / saveLlmConfig", () => {
  it("savePrompt retorna erro em 0 linhas com a copy específica", async () => {
    serverTableResults = { projects: { data: [] } };
    const r = await savePrompt("p1", "novo prompt");
    expect(r.error).toMatch(/Não foi possível salvar o prompt/);
  });

  it("saveLlmConfig retorna erro em 0 linhas com a copy específica", async () => {
    serverTableResults = { projects: { data: [] } };
    const r = await saveLlmConfig("p1", {
      llm_provider: "google",
      llm_model: "gemini",
      llm_kwargs: {},
    });
    expect(r.error).toMatch(/configuração do LLM/);
  });
});
