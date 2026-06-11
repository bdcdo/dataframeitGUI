import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PydanticField } from "@/lib/types";
import {
  makeSupabaseMock,
  type TableResult,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

// Cobertura dos dois lados da divergência sugestão × schema (#178):
// (a) schema não aplicado → sugestão não pode virar "approved";
// (b) schema aplicado mas UPDATE de schema_suggestions filtrado pela RLS
//     (0 linhas) → a action não pode retornar sucesso com a sugestão pendente.

let writeCalls: WriteCall[];
let serverTableResults: TableResults | undefined;

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "userCoord" }),
  isProjectCoordinator: async () => true,
}));
vi.mock("@/lib/api", () => ({
  fetchFastAPI: async () => ({ valid: true, fields: [], model_name: null, errors: [] }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({ tableResults: serverTableResults, writeCalls }),
}));

import {
  approveSchemaSuggestionWithEdits,
  resolveSchemaSuggestion,
} from "../suggestions";

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

describe("approveSchemaSuggestionWithEdits", () => {
  it("schema não aplicado (0 linhas em projects) → erro e sugestão NÃO marcada como aprovada", async () => {
    serverTableResults = {
      projects: [PROJECT_SELECT, { data: [] }],
    };

    const r = await approveSchemaSuggestionWithEdits("s1", "p1", [FIELD]);
    expect(r.error).toMatch(/sem permissão/i);
    expect(
      writeCalls.some((c) => c.table === "schema_suggestions" && c.op === "update"),
    ).toBe(false);
  });

  it("schema aplicado mas UPDATE de schema_suggestions filtrado (0 linhas) → erro, não sucesso falso", async () => {
    serverTableResults = {
      projects: [PROJECT_SELECT, { data: [{ id: "p1" }] }],
      schema_change_log: { data: null, error: null },
      schema_suggestions: { data: [] },
    };

    const r = await approveSchemaSuggestionWithEdits("s1", "p1", [FIELD]);
    expect(r.error).toMatch(/Schema aplicado.*sem permissão/);
  });

  it("caminho feliz: schema aplicado e sugestão marcada como aprovada", async () => {
    serverTableResults = {
      projects: [PROJECT_SELECT, { data: [{ id: "p1" }] }],
      schema_change_log: { data: null, error: null },
      schema_suggestions: { data: [{ id: "s1" }] },
    };

    const r = await approveSchemaSuggestionWithEdits("s1", "p1", [FIELD]);
    expect(r.error).toBeUndefined();
    const suggestionUpdate = writeCalls.find(
      (c) => c.table === "schema_suggestions" && c.op === "update",
    );
    expect(suggestionUpdate?.payload).toMatchObject({ status: "approved" });
  });
});

describe("resolveSchemaSuggestion (rejected)", () => {
  it("UPDATE de schema_suggestions filtrado (0 linhas) → erro", async () => {
    serverTableResults = {
      schema_suggestions: { data: [] },
    };

    const r = await resolveSchemaSuggestion("s1", "p1", "rejected", "fora de escopo");
    expect(r.error).toMatch(/Sem permissão para resolver/);
  });

  it("caminho feliz: rejeição persiste com rejection_reason", async () => {
    serverTableResults = {
      schema_suggestions: { data: [{ id: "s1" }] },
    };

    const r = await resolveSchemaSuggestion("s1", "p1", "rejected", "fora de escopo");
    expect(r.error).toBeUndefined();
    const upd = writeCalls.find(
      (c) => c.table === "schema_suggestions" && c.op === "update",
    );
    expect(upd?.payload).toMatchObject({
      status: "rejected",
      rejection_reason: "fora de escopo",
    });
  });
});
