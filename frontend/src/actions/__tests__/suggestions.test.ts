import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseMock,
  type RpcCall,
  type TableResult,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";
import { EMPTY_BASELINE, FIELD, PROJECT_SELECT } from "./schema-test-fixtures";

// A RPC atômica torna irrepresentável a divergência sugestão × schema (#178).

const supabaseState = vi.hoisted(() => ({
  writeCalls: [] as WriteCall[],
  tableResults: undefined as TableResults | undefined,
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  rpcCalls: [] as RpcCall[],
  rpcResults: undefined as Record<string, TableResult> | undefined,
}));

vi.mock("next/cache", () => ({
  revalidatePath: supabaseState.revalidatePath,
  revalidateTag: supabaseState.revalidateTag,
}));
vi.mock("@/lib/auth", () => {
  const user = { id: "userCoord" };
  return {
    getAuthUser: async () => user,
    isProjectCoordinator: async () => true,
    requireCoordinator: async () => ({ ok: true, user }),
  };
});
vi.mock("@/lib/api-server", () => ({
  fetchFastAPIServer: async () => ({ valid: true, fields: [], model_name: null, errors: [] }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({
      tableResults: supabaseState.tableResults,
      writeCalls: supabaseState.writeCalls,
      rpcCalls: supabaseState.rpcCalls,
      rpcResults: supabaseState.rpcResults,
    }),
}));

import {
  approveSchemaSuggestionWithEdits,
  createSchemaSuggestion,
  resolveSchemaSuggestion,
} from "../suggestions";

beforeEach(() => {
  supabaseState.writeCalls = [];
  supabaseState.tableResults = undefined;
  supabaseState.rpcCalls = [];
  supabaseState.rpcResults = undefined;
});

const savedSchema = {
  data: {
    status: "saved",
    schema_revision: 1,
    pydantic_fields: [{ ...FIELD, hash: "hash" }],
    schema_version_major: 0,
    schema_version_minor: 2,
    schema_version_patch: 0,
  },
};

describe("createSchemaSuggestion", () => {
  it("rejeita suggested_changes malformado antes do INSERT", async () => {
    const result = await createSchemaSuggestion(
      "p1",
      "q1",
      { unexpected: true } as never,
      "Ajuste",
    );

    expect(result.error).toMatch(/inválid/i);
    expect(supabaseState.writeCalls).toHaveLength(0);
  });
});

describe("approveSchemaSuggestionWithEdits", () => {
  it("falha da RPC atômica não produz update paralelo", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    supabaseState.tableResults = {
      projects: PROJECT_SELECT,
    };
    supabaseState.rpcResults = {
      approve_schema_suggestion: { error: { code: "42501", message: "sem permissão" } },
    };

    const r = await approveSchemaSuggestionWithEdits(
      "s1",
      "p1",
      [FIELD],
      EMPTY_BASELINE,
    );
    expect(r.error).toBe("Não foi possível aplicar a sugestão. Tente novamente.");
    expect(
      supabaseState.writeCalls.some(
        (call) => call.table === "schema_suggestions" && call.op === "update",
      ),
    ).toBe(false);
    consoleError.mockRestore();
  });

  // P0001 é a condição de negócio da RPC ("sugestão ausente, de outro projeto ou
  // já resolvida"). Diferente das violações de contrato, ela é acionável — o
  // usuário precisa saber que a sugestão saiu de pendente — e por isso ganha
  // copy pt-BR própria em vez da genérica.
  it("sugestão não pendente volta com copy pt-BR específica", async () => {
    supabaseState.tableResults = {
      projects: PROJECT_SELECT,
    };
    supabaseState.rpcResults = {
      approve_schema_suggestion: {
        error: {
          code: "P0001",
          message:
            "Suggestion is missing, belongs to another project, or is not pending",
        },
      },
    };

    const r = await approveSchemaSuggestionWithEdits(
      "s1",
      "p1",
      [FIELD],
      EMPTY_BASELINE,
    );
    expect(r.error).toBe("Sugestão não encontrada ou já resolvida.");
  });

  it("caminho feliz: schema aplicado e sugestão marcada como aprovada", async () => {
    supabaseState.tableResults = {
      projects: PROJECT_SELECT,
    };
    supabaseState.rpcResults = { approve_schema_suggestion: savedSchema };

    const r = await approveSchemaSuggestionWithEdits(
      "s1",
      "p1",
      [FIELD],
      EMPTY_BASELINE,
    );
    expect(r.error).toBeUndefined();
    expect(supabaseState.rpcCalls).toContainEqual({
      fn: "approve_schema_suggestion",
      args: expect.objectContaining({ p_suggestion_id: "s1", p_project_id: "p1" }),
    });
    expect(supabaseState.writeCalls).toHaveLength(0);
  });
});

describe("resolveSchemaSuggestion (rejected)", () => {
  it("UPDATE de schema_suggestions filtrado (0 linhas) → erro", async () => {
    supabaseState.tableResults = {
      schema_suggestions: { data: [] },
    };

    const r = await resolveSchemaSuggestion("s1", "p1", "rejected", "fora de escopo");
    expect(r.error).toMatch(/Sem permissão para resolver/);
  });

  it("caminho feliz: rejeição persiste com rejection_reason", async () => {
    supabaseState.tableResults = {
      schema_suggestions: { data: [{ id: "s1" }] },
    };

    const r = await resolveSchemaSuggestion("s1", "p1", "rejected", "fora de escopo");
    expect(r.error).toBeUndefined();
    const upd = supabaseState.writeCalls.find(
      (c) => c.table === "schema_suggestions" && c.op === "update",
    );
    expect(upd?.payload).toMatchObject({
      status: "rejected",
      rejection_reason: "fora de escopo",
    });
  });
});
