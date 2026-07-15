import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseMock,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";
import { EMPTY_BASELINE, FIELD, PROJECT_SELECT } from "./schema-test-fixtures";

// Cobertura dos dois lados da divergência sugestão × schema (#178):
// (a) schema não aplicado → sugestão não pode virar "approved";
// (b) schema aplicado mas UPDATE de schema_suggestions filtrado pela RLS
//     (0 linhas) → a action não pode retornar sucesso com a sugestão pendente.

const supabaseState = vi.hoisted(() => ({
  writeCalls: [] as WriteCall[],
  tableResults: undefined as TableResults | undefined,
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
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
    }),
}));

import {
  approveSchemaSuggestionWithEdits,
  resolveSchemaSuggestion,
} from "../suggestions";

beforeEach(() => {
  supabaseState.writeCalls = [];
  supabaseState.tableResults = undefined;
});

describe("approveSchemaSuggestionWithEdits", () => {
  it("schema não aplicado (0 linhas em projects) → erro e sugestão NÃO marcada como aprovada", async () => {
    supabaseState.tableResults = {
      projects: [PROJECT_SELECT, { data: [] }],
    };

    const r = await approveSchemaSuggestionWithEdits(
      "s1",
      "p1",
      [FIELD],
      EMPTY_BASELINE,
    );
    expect(r.error).toMatch(/sem permissão/i);
    expect(
      supabaseState.writeCalls.some(
        (call) => call.table === "schema_suggestions" && call.op === "update",
      ),
    ).toBe(false);
  });

  it("schema aplicado mas UPDATE de schema_suggestions filtrado (0 linhas) → erro, não sucesso falso", async () => {
    supabaseState.tableResults = {
      projects: [PROJECT_SELECT, { data: [{ id: "p1" }] }],
      schema_change_log: { data: null, error: null },
      schema_suggestions: { data: [] },
    };

    const r = await approveSchemaSuggestionWithEdits(
      "s1",
      "p1",
      [FIELD],
      EMPTY_BASELINE,
    );
    expect(r.error).toMatch(/Schema aplicado.*sem permissão/);
  });

  it("caminho feliz: schema aplicado e sugestão marcada como aprovada", async () => {
    supabaseState.tableResults = {
      projects: [PROJECT_SELECT, { data: [{ id: "p1" }] }],
      schema_change_log: { data: null, error: null },
      schema_suggestions: { data: [{ id: "s1" }] },
    };

    const r = await approveSchemaSuggestionWithEdits(
      "s1",
      "p1",
      [FIELD],
      EMPTY_BASELINE,
    );
    expect(r.error).toBeUndefined();
    const suggestionUpdate = supabaseState.writeCalls.find(
      (c) => c.table === "schema_suggestions" && c.op === "update",
    );
    expect(suggestionUpdate?.payload).toMatchObject({ status: "approved" });
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
