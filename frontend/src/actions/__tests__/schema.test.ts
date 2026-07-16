import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeSupabaseMock,
  type RpcCall,
  type TableResult,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";
import { EMPTY_BASELINE, FIELD, PROJECT_SELECT } from "./schema-test-fixtures";
import type { PydanticField } from "@/lib/types";

const state = vi.hoisted(() => ({
  writes: [] as WriteCall[],
  rpcs: [] as RpcCall[],
  tables: undefined as TableResults | undefined,
  rpcResults: undefined as Record<string, TableResult | TableResult[]> | undefined,
}));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser: async () => ({ id: "userCoord" }) }));
vi.mock("@/lib/api-server", () => ({ fetchFastAPIServer: fetchMock }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({
      tableResults: state.tables,
      writeCalls: state.writes,
      rpcCalls: state.rpcs,
      rpcResults: state.rpcResults,
    }),
}));

import {
  backfillSchemaVersionHistory,
  publishMajorVersion,
  recoverFieldsFromStoredCode,
  saveLlmConfig,
  savePrompt,
  saveSchemaFromGUI,
} from "../schema";

function commitRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "saved",
    schema_revision: 1,
    pydantic_fields: [{ ...FIELD, hash: "field-hash" }],
    schema_version_major: 0,
    schema_version_minor: 2,
    schema_version_patch: 0,
    ...overrides,
  };
}

beforeEach(() => {
  state.writes = [];
  state.rpcs = [];
  state.tables = undefined;
  state.rpcResults = undefined;
  fetchMock.mockReset();
});

describe("saveSchemaFromGUI", () => {
  it("persiste schema e histórico numa única RPC e devolve snapshot canônico", async () => {
    state.tables = { projects: PROJECT_SELECT };
    state.rpcResults = { commit_project_schema: { data: commitRow() } };

    const result = await saveSchemaFromGUI("p1", [FIELD], EMPTY_BASELINE);

    expect(result).toEqual({
      status: "saved",
      snapshot: {
        revision: 1,
        version: "0.2.0",
        fields: [{ ...FIELD, hash: "field-hash" }],
      },
    });
    expect(state.rpcs).toHaveLength(1);
    expect(state.rpcs[0]).toMatchObject({
      fn: "commit_project_schema",
      args: {
        p_project_id: "p1",
        p_expected_revision: 0,
        p_version_major: 0,
        p_version_minor: 2,
        p_version_patch: 0,
        p_change_type: "minor",
        p_changed_by: "userCoord",
        p_log_entries: [expect.objectContaining({ field_name: "q1" })],
      },
    });
    expect(state.writes).toHaveLength(0);
  });

  it("permite o primeiro save quando o projeto parte do schema vazio canônico", async () => {
    state.tables = {
      projects: {
        data: { ...(PROJECT_SELECT.data as object), pydantic_fields: [] },
      },
    };
    state.rpcResults = { commit_project_schema: { data: commitRow() } };

    const result = await saveSchemaFromGUI("p1", [FIELD], EMPTY_BASELINE);

    expect(result.status).toBe("saved");
    expect(state.rpcs).toHaveLength(1);
  });

  it("baseline antigo retorna conflito antes de calcular ou escrever", async () => {
    state.tables = {
      projects: {
        data: {
          ...(PROJECT_SELECT.data as Record<string, unknown>),
          schema_revision: 2,
          schema_version_minor: 3,
          pydantic_fields: [FIELD],
        },
      },
    };

    const result = await saveSchemaFromGUI("p1", [FIELD], EMPTY_BASELINE);

    expect(result).toEqual({
      status: "conflict",
      current: { fields: [FIELD], version: "0.3.0", revision: 2 },
    });
    expect(state.rpcs).toHaveLength(0);
  });

  it("corrida depois da leitura mapeia o snapshot remoto retornado pela RPC", async () => {
    const remote = { ...FIELD, description: "Mudança remota" };
    state.tables = { projects: PROJECT_SELECT };
    state.rpcResults = {
      commit_project_schema: {
        data: commitRow({
          status: "conflict",
          schema_revision: 4,
          schema_version_minor: 3,
          pydantic_fields: [remote],
        }),
      },
    };

    const result = await saveSchemaFromGUI("p1", [FIELD], EMPTY_BASELINE);

    expect(result).toEqual({
      status: "conflict",
      current: { fields: [remote], version: "0.3.0", revision: 4 },
    });
  });

  it("falha transacional só pode retornar error, nunca saved + error", async () => {
    state.tables = { projects: PROJECT_SELECT };
    state.rpcResults = {
      commit_project_schema: { error: { message: "histórico indisponível" } },
    };

    const result = await saveSchemaFromGUI("p1", [FIELD], EMPTY_BASELINE);

    expect(result).toEqual({ status: "error", message: "histórico indisponível" });
    expect("snapshot" in result).toBe(false);
  });

  it("recusa schema vazio na fronteira canônica", async () => {
    state.tables = {
      projects: {
        data: { ...(PROJECT_SELECT.data as object), pydantic_fields: [FIELD] },
      },
    };
    const result = await saveSchemaFromGUI("p1", [], {
      revision: 0,
    });
    expect(result).toMatchObject({ status: "error", message: expect.stringMatching(/inválido/i) });
    expect(state.rpcs).toHaveLength(0);
  });

  it("save sem mudanças mantém a revisão e não chama a RPC", async () => {
    state.tables = {
      projects: {
        data: { ...(PROJECT_SELECT.data as object), pydantic_fields: [FIELD] },
      },
    };
    const result = await saveSchemaFromGUI("p1", [FIELD], EMPTY_BASELINE);
    expect(result).toEqual({
      status: "saved",
      snapshot: { fields: [FIELD], version: "0.1.0", revision: 0 },
    });
    expect(state.rpcs).toHaveLength(0);
  });

  it("rejeita propriedades desconhecidas recebidas do cliente", async () => {
    state.tables = { projects: PROJECT_SELECT };
    const malformed = [{ ...FIELD, unexpected: "client input" }] as unknown as PydanticField[];
    const result = await saveSchemaFromGUI("p1", malformed, EMPTY_BASELINE);
    expect(result).toMatchObject({ status: "error", message: expect.stringMatching(/inválido/i) });
    expect(state.rpcs).toHaveLength(0);
  });

  it("não tenta salvar quando o schema persistido viola o contrato", async () => {
    state.tables = {
      projects: {
        data: {
          ...(PROJECT_SELECT.data as object),
          pydantic_fields: [FIELD, { ...FIELD, description: "Duplicado" }],
        },
      },
    };

    const result = await saveSchemaFromGUI("p1", [FIELD], EMPTY_BASELINE);

    expect(result).toMatchObject({
      status: "error",
      message: expect.stringMatching(/persistido.*inválido/i),
    });
    expect(state.rpcs).toHaveLength(0);
  });
});

describe("publishMajorVersion", () => {
  it("publica MAJOR e histórico na mesma RPC", async () => {
    state.tables = {
      projects: {
        data: {
          ...(PROJECT_SELECT.data as object),
          pydantic_fields: [FIELD],
          schema_version_minor: 18,
          schema_revision: 7,
        },
      },
    };
    state.rpcResults = {
      commit_project_schema: {
        data: commitRow({
          schema_revision: 8,
          schema_version_major: 1,
          schema_version_minor: 0,
          pydantic_fields: [FIELD],
        }),
      },
    };

    const result = await publishMajorVersion("p1", {
      revision: 7,
    });

    expect(result).toMatchObject({
      status: "saved",
      snapshot: { revision: 8, version: "1.0.0" },
    });
    expect(state.rpcs[0]).toMatchObject({
      fn: "commit_project_schema",
      args: {
        p_expected_revision: 7,
        p_change_type: "major",
        p_version_major: 1,
        p_version_minor: 0,
        p_version_patch: 0,
        p_log_entries: [expect.objectContaining({ field_name: "(projeto)" })],
      },
    });
    expect(state.writes).toHaveLength(0);
  });

  it("não publica sobre uma revisão que o usuário nunca viu", async () => {
    state.tables = {
      projects: {
        data: {
          ...(PROJECT_SELECT.data as object),
          schema_revision: 8,
          schema_version_minor: 19,
        },
      },
    };
    const result = await publishMajorVersion("p1", {
      revision: 7,
    });
    expect(result).toMatchObject({
      status: "conflict",
      current: { revision: 8, version: "0.19.0" },
    });
    expect(state.rpcs).toHaveLength(0);
  });
});

describe("backfillSchemaVersionHistory", () => {
  it("calcula em TypeScript e aplica logs, respostas e revisão numa única RPC", async () => {
    state.tables = {
      projects: {
        data: {
          pydantic_fields: [FIELD],
          schema_version_major: 0,
          schema_version_minor: 1,
          schema_version_patch: 0,
          schema_revision: 3,
        },
      },
      schema_change_log: {
        data: [{
          id: "log-1",
          field_name: "q1",
          before_value: {},
          after_value: FIELD,
          created_at: "2026-01-01T00:00:00.000Z",
          change_type: null,
        }],
      },
      responses: { data: [] },
    };
    state.rpcResults = {
      apply_schema_backfill: {
        data: commitRow({ schema_revision: 4, pydantic_fields: [FIELD] }),
      },
    };

    const result = await backfillSchemaVersionHistory("p1");

    expect(result).toMatchObject({
      status: "saved",
      stats: { logEntriesUpdated: 1, responsesProcessed: 0 },
      snapshot: { revision: 4 },
    });
    expect(state.rpcs).toEqual([
      expect.objectContaining({
        fn: "apply_schema_backfill",
        args: expect.objectContaining({
          p_expected_revision: 3,
          p_log_updates: [expect.objectContaining({ id: "log-1", change_type: "minor" })],
          p_response_updates: [],
        }),
      }),
    ]);
    expect(state.writes).toHaveLength(0);
  });
});

describe("recoverFieldsFromStoredCode", () => {
  it("recupera os campos usando apenas o project_id", async () => {
    fetchMock.mockResolvedValueOnce({ valid: true, fields: [FIELD], model_name: "Analysis", errors: [] });
    const result = await recoverFieldsFromStoredCode("p1");
    expect(result).toEqual({ fields: [FIELD] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pydantic/recover-fields",
      expect.objectContaining({ body: JSON.stringify({ project_id: "p1" }) }),
    );
  });
});

describe("savePrompt / saveLlmConfig", () => {
  it("mantém as mensagens específicas quando RLS filtra o update", async () => {
    state.tables = { projects: { data: [] } };
    await expect(savePrompt("p1", "prompt")).resolves.toMatchObject({
      error: expect.stringMatching(/salvar o prompt/i),
    });
    state.tables = { projects: { data: [] } };
    await expect(saveLlmConfig("p1", {
      llm_provider: "google",
      llm_model: "gemini",
      llm_kwargs: {},
    })).resolves.toMatchObject({ error: expect.stringMatching(/configuração do LLM/i) });
  });
});
