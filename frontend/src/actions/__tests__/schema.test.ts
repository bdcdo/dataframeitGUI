import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PydanticField } from "@/lib/types";
import {
  makeSupabaseMock,
  type TableResult,
  type TableResults,
  type WriteCall,
  type RpcCall,
} from "./supabase-mock";

// Testes do conserto da #178: o UPDATE de projects filtrado pela RLS retorna
// sucesso com 0 linhas no PostgREST — antes, saveSchemaFromGUI seguia em
// frente e inseria entradas em schema_change_log, gerando histórico fantasma.
// As actions retornam { error } (não lançam): o Next mascara a message de
// erros lançados em Server Actions em produção.

let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let serverRpcResults: Record<string, TableResult> | undefined;
let serverTableResults: TableResults | undefined;

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "userCoord" }),
  getEffectiveMemberId: async () => "memberCoord",
  resolveProjectActor: async () => ({
    ok: true,
    user: { id: "userCoord" },
    effectiveUserId: "memberCoord",
  }),
}));
vi.mock("@/lib/api-server", () => ({
  fetchFastAPIServer: fetchMock,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({
      tableResults: serverTableResults,
      writeCalls,
      rpcCalls,
      rpcResults: serverRpcResults,
    }),
}));

import {
  saveSchemaFromGUI,
  savePrompt,
  publishMajorVersion,
  saveLlmConfig,
  recoverFieldsFromStoredCode,
  backfillSchemaVersionHistory,
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
  rpcCalls = [];
  serverRpcResults = undefined;
  serverTableResults = undefined;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    valid: true,
    fields: [],
    model_name: null,
    errors: [],
  });
});

describe("backfillSchemaVersionHistory", () => {
  it("versiona todas as respostas por uma única RPC atômica", async () => {
    serverTableResults = {
      projects: [
        {
          data: {
            pydantic_fields: [FIELD],
            schema_version_major: 0,
            schema_version_minor: 1,
            schema_version_patch: 0,
          },
        },
        { data: [{ id: "p1" }] },
      ],
      schema_change_log: { data: [] },
      responses: [
        {
          data: [
            {
              id: "r1",
              created_at: "2026-01-01T00:00:00.000Z",
              answer_field_hashes: null,
              version_inferred_from: null,
            },
          ],
        },
      ],
    };
    serverRpcResults = { set_response_schema_versions: { data: 1 } };

    const result = await backfillSchemaVersionHistory("p1");

    expect(result.error).toBeUndefined();
    expect(result.stats?.responsesProcessed).toBe(1);
    expect(rpcCalls).toContainEqual({
      fn: "set_response_schema_versions",
      args: {
        p_project_id: "p1",
        p_updates: [
          {
            id: "r1",
            schema_version_major: 0,
            schema_version_minor: 1,
            schema_version_patch: 0,
            version_inferred_from: "created_at",
          },
        ],
      },
    });
    expect(
      writeCalls.some(
        (call) => call.table === "responses" && call.op === "update",
      ),
    ).toBe(false);
  });
});

describe("saveSchemaFromGUI", () => {
  it("falha fechada quando o estado anterior do projeto não pode ser lido", async () => {
    serverTableResults = {
      projects: { data: null, error: { message: "timeout projeto" } },
    };

    await expect(saveSchemaFromGUI("p1", [FIELD])).resolves.toEqual({
      error: "timeout projeto",
    });
    expect(writeCalls).toHaveLength(0);
  });

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
      changed_by: "memberCoord",
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

  it("guarda anti-wipe: 0 campos sobre schema não-vazio é recusado sem tocar projects", async () => {
    // Projeto já tem 1 campo; salvar com [] apagaria o schema → recusa.
    serverTableResults = {
      projects: [{ data: { ...(PROJECT_SELECT.data as Record<string, unknown>), pydantic_fields: [FIELD] } }],
    };

    const r = await saveSchemaFromGUI("p1", []);
    expect(r.error).toMatch(/0 campos|apagaria/i);
    expect(writeCalls.some((c) => c.table === "projects" && c.op === "update")).toBe(false);
  });

  it("guarda anti-wipe (legado): 0 campos com pydantic_fields vazio mas pydantic_code presente é recusado", async () => {
    // Caso legado: pydantic_fields vazio, mas o schema vive em pydantic_code.
    // A guarda precisa enxergar o código — checar só oldFields.length deixaria
    // o wipe passar exatamente neste cenário.
    serverTableResults = {
      projects: [
        {
          data: {
            ...(PROJECT_SELECT.data as Record<string, unknown>),
            pydantic_fields: [],
            pydantic_code: "class Analysis(BaseModel):\n    q1: str\n",
          },
        },
      ],
    };

    const r = await saveSchemaFromGUI("p1", []);
    expect(r.error).toMatch(/0 campos|apagaria/i);
    expect(writeCalls.some((c) => c.table === "projects" && c.op === "update")).toBe(false);
  });

  it("permite salvar [] quando o schema já estava vazio (sem campos e sem código)", async () => {
    serverTableResults = {
      projects: [PROJECT_SELECT, { data: [{ id: "p1" }] }],
    };
    const r = await saveSchemaFromGUI("p1", []);
    expect(r.error).toBeUndefined();
  });
});

describe("recoverFieldsFromStoredCode", () => {
  it("retorna os campos reconstruídos pelo backend a partir do código armazenado", async () => {
    fetchMock.mockResolvedValueOnce({
      valid: true,
      fields: [FIELD],
      model_name: "Analysis",
      errors: [],
    });
    const r = await recoverFieldsFromStoredCode("p1");
    expect(r.error).toBeUndefined();
    expect(r.fields).toEqual([FIELD]);
    // Envia project_id, nunca código do cliente.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pydantic/recover-fields",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ project_id: "p1" }) }),
    );
  });

  it("propaga erro quando o backend não consegue reconstruir", async () => {
    fetchMock.mockResolvedValueOnce({
      valid: false,
      fields: [],
      model_name: null,
      errors: ["código inválido"],
    });
    const r = await recoverFieldsFromStoredCode("p1");
    expect(r.fields).toBeUndefined();
    expect(r.error).toBe("código inválido");
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
