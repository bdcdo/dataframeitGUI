import { describe, it, expect, beforeEach, vi } from "vitest";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";
import {
  callsOf,
  makeFilterAwareSupabaseMock,
  type QueryError,
  type RpcCall,
  type RpcResult,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { EMPTY_BASELINE, FIELD, projectRow } from "./schema-test-fixtures";

// A RPC atômica torna irrepresentável a divergência sugestão × schema (#178).

const supabaseState = vi.hoisted(() => ({
  writeCalls: [] as WriteCall[],
  tableData: {} as Record<string, unknown[]>,
  queryErrors: {} as Record<string, QueryError>,
  revalidatePath: vi.fn(),
  rpcCalls: [] as RpcCall[],
  rpcResults: {} as Record<string, RpcResult>,
}));

vi.mock("next/cache", () => ({
  revalidatePath: supabaseState.revalidatePath,
}));
// isProjectCoordinator saiu de @/lib/auth neste branch (identidade canônica);
// o shape do mock segue o da main (#454), sem o símbolo removido.
vi.mock("@/lib/auth", () => {
  const user = { id: "userCoord" };
  return {
    getAuthUser: async () => user,
    requireCoordinator: async () => ({ ok: true, user }),
  };
});
vi.mock("@/lib/api-server", () => ({
  fetchFastAPIServer: async () => ({ valid: true, fields: [], model_name: null, errors: [] }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeFilterAwareSupabaseMock({
      tableData: supabaseState.tableData,
      queryErrors: supabaseState.queryErrors,
      writeCalls: supabaseState.writeCalls,
      rpcCalls: supabaseState.rpcCalls,
      rpcResults: supabaseState.rpcResults,
    }),
}));

import {
  approveSchemaSuggestionWithEdits,
  createSchemaSuggestion,
  rejectSchemaSuggestion,
} from "../suggestions";

const otherProject = projectRow({ id: "p2", schema_revision: 9 });

beforeEach(() => {
  supabaseState.writeCalls = [];
  // p1, e p2 como a linha que a leitura por id precisa descartar.
  supabaseState.tableData = { projects: [projectRow(), otherProject] };
  supabaseState.queryErrors = {};
  supabaseState.rpcCalls = [];
  supabaseState.rpcResults = {};
  supabaseState.revalidatePath.mockClear();
});

// Sugestão s1, pendente em p1, com as colunas que o UPDATE da rejeição filtra.
const suggestion = (extra: Record<string, unknown> = {}) => ({
  id: "s1", project_id: "p1", status: "pending", ...extra,
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

// #502: o `error.message` do Postgres ia cru, em inglês, para o toast pt-BR.
describe("erros do Postgres não chegam crus ao toast", () => {
  const postgresError = {
    code: "57014",
    message: "canceling statement due to statement timeout",
  };

  it("createSchemaSuggestion devolve copy pt-BR e loga o erro", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    supabaseState.queryErrors = { "schema_suggestions:insert": postgresError };

    const r = await createSchemaSuggestion("p1", "q1", { description: "Nova" }, "Ajuste");

    expect(r.error).toEqual(copyWithRef("Não foi possível enviar a sugestão. Tente novamente."));
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[suggestions] criação da sugestão falhou", { code: "57014" }),
    );
    consoleError.mockRestore();
  });

  it("createSchemaSuggestion barrada pela RLS diz que falta permissão", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    supabaseState.queryErrors = {
      "schema_suggestions:insert": {
        code: "42501",
        message: 'new row violates row-level security policy for table "schema_suggestions"',
      },
    };

    const r = await createSchemaSuggestion("p1", "q1", { description: "Nova" }, "Ajuste");

    expect(r.error).toBe("Sem permissão para sugerir alterações neste projeto.");
    consoleError.mockRestore();
  });

  it("rejectSchemaSuggestion devolve copy pt-BR e loga o erro", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    supabaseState.tableData.schema_suggestions = [suggestion()];
    supabaseState.queryErrors = { "schema_suggestions:update": postgresError };

    const r = await rejectSchemaSuggestion("s1", "p1");

    expect(r.error).toEqual(copyWithRef("Não foi possível rejeitar a sugestão. Tente novamente."));
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[suggestions] rejeição da sugestão falhou", { code: "57014" }),
    );
    consoleError.mockRestore();
  });
});

describe("approveSchemaSuggestionWithEdits", () => {
  it("falha da RPC atômica não produz update paralelo", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    supabaseState.rpcResults = {
      approve_schema_suggestion: { error: { code: "42501", message: "sem permissão" } },
    };

    const r = await approveSchemaSuggestionWithEdits(
      "s1",
      "p1",
      [FIELD],
      EMPTY_BASELINE,
    );
    expect(r.error).toEqual(copyWithRef("Não foi possível aplicar a sugestão. Tente novamente."));
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

  // O coordenador já tinha aplicado a mudança à mão quando foi aprovar. Não há
  // diff, e `commit_project_schema` recusa log vazio por contrato — aprovar pela
  // RPC de commit devolvia erro e deixava a sugestão pendente PARA SEMPRE, com
  // rejeitá-la como única saída para uma sugestão que foi atendida.
  describe("sugestão cujo conteúdo o schema já tem", () => {
    beforeEach(() => {
      supabaseState.tableData.projects = [projectRow({ pydantic_fields: [FIELD] }), otherProject];
    });

    it("é aprovada sem commitar schema", async () => {
      supabaseState.rpcResults = {
        resolve_schema_suggestion: {
          data: {
            status: "saved",
            schema_revision: 0,
            pydantic_fields: [FIELD],
            schema_version_major: 0,
            schema_version_minor: 1,
            schema_version_patch: 0,
          },
        },
      };

      const r = await approveSchemaSuggestionWithEdits(
        "s1",
        "p1",
        [FIELD],
        EMPTY_BASELINE,
      );

      expect(r.error).toBeUndefined();
      expect(supabaseState.rpcCalls).toContainEqual({
        fn: "resolve_schema_suggestion",
        args: {
          p_suggestion_id: "s1",
          p_project_id: "p1",
          p_expected_revision: 0,
          p_resolved_by: "userCoord",
        },
      });
      // Nada a commitar: o schema não mudou, e bumpar a versão registraria no
      // histórico uma alteração que ninguém fez.
      expect(
        supabaseState.rpcCalls.some((c) => c.fn === "commit_project_schema"),
      ).toBe(false);
      expect(
        supabaseState.rpcCalls.some((c) => c.fn === "approve_schema_suggestion"),
      ).toBe(false);
    });

    it("revisão mudada entre a leitura e a aprovação volta como conflito", async () => {
      supabaseState.rpcResults = {
        resolve_schema_suggestion: {
          data: {
            status: "conflict",
            schema_revision: 7,
            pydantic_fields: [FIELD],
            schema_version_major: 0,
            schema_version_minor: 1,
            schema_version_patch: 0,
          },
        },
      };

      const r = await approveSchemaSuggestionWithEdits(
        "s1",
        "p1",
        [FIELD],
        EMPTY_BASELINE,
      );
      // O conflito volta tipado com o snapshot atual, para o EditFieldDialog
      // re-mesclar e reenviar em vez de descartar a edição (#501).
      expect(r.error).toBeUndefined();
      expect(r.conflict).toMatchObject({ revision: 7, fields: [FIELD] });
    });

    it("sugestão já resolvida volta com a copy pt-BR da RPC", async () => {
      supabaseState.rpcResults = {
        resolve_schema_suggestion: {
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
  });
});

describe("rejectSchemaSuggestion", () => {
  // O filtro status='pending' zera o UPDATE também na corrida normal (outro
  // coordenador aprovou segundos antes) — a copy é a mesma da RPC irmã, não um
  // falso erro de autorização para quem tem permissão.
  it("UPDATE de schema_suggestions filtrado (0 linhas) → copy de já resolvida", async () => {
    // s1 já foi aprovada; s2, pendente, é de outro projeto.
    supabaseState.tableData.schema_suggestions = [
      suggestion({ status: "approved" }),
      suggestion({ id: "s2", project_id: "p2" }),
    ];

    for (const id of ["s1", "s2", "s3"]) {
      const r = await rejectSchemaSuggestion(id, "p1", "fora de escopo");
      expect(r.error).toBe("Sugestão não encontrada ou já resolvida.");
    }
    expect(supabaseState.revalidatePath).not.toHaveBeenCalled();
  });

  it("caminho feliz: rejeição persiste com rejection_reason", async () => {
    supabaseState.tableData.schema_suggestions = [suggestion(), suggestion({ id: "s2" })];

    const r = await rejectSchemaSuggestion("s1", "p1", "fora de escopo");
    expect(r.error).toBeUndefined();
    const [upd, ...others] = callsOf(supabaseState.writeCalls, "update", "schema_suggestions");
    expect(others).toEqual([]);
    expect(upd?.payload).toMatchObject({
      status: "rejected",
      rejection_reason: "fora de escopo",
    });
    expect(upd?.filters).toEqual([
      ["eq", "id", "s1"],
      ["eq", "project_id", "p1"],
      ["eq", "status", "pending"],
    ]);
  });
});
