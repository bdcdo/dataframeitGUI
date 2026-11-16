import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeFilterAwareSupabaseMock, type ReadCall, type RpcCall } from "@/test-utils/supabase-mock";

const captured = vi.hoisted(() => ({ view: null as Record<string, unknown> | null }));
let tableData: Record<string, unknown[]>;
let readCalls: ReadCall[];
let rpcCalls: RpcCall[];
let afterRead: ((source: string) => void) | undefined;
let rpcResults: Parameters<typeof makeFilterAwareSupabaseMock>[0]["rpcResults"];

vi.mock("@/lib/page-auth", () => ({ requirePageAuthUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/auth", () => ({ getProjectAccessContext: async () => ({ status: "resolved", canResolve: true }) }));
vi.mock("@/lib/project-access", () => ({ coordinatorGate: () => true }));
vi.mock("@/components/stats/LlmInsightsView", () => ({
  LlmInsightsView: (props: Record<string, unknown>) => {
    captured.view = props;
    return null;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeFilterAwareSupabaseMock({
    tableData, readCalls, rpcCalls, rpcResults, afterRead, writeCalls: [], projectColumns: true,
  }),
}));

let Page: typeof import("../page")["default"];
beforeAll(async () => { Page = (await import("../page")).default; }, 30_000);
beforeEach(() => {
  captured.view = null;
  readCalls = [];
  rpcCalls = [];
  afterRead = undefined;
  rpcResults = { read_error_resolutions: { data: [] } };
  tableData = {
    projects: [{ id: "p1", pydantic_fields: [], schema_revision: 0, automation_mode: null }],
    responses: [], reviews: [], documents: [], value_equivalences: [], final_answers: [],
  };
});

async function renderPage() {
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "p1" }) }));
}

describe("LLM Insights — cursor nas fontes reais", () => {
  it("mantém 1001 documentos LLM após remoção antes da segunda página", async () => {
    tableData.documents = Array.from({ length: 1001 }, (_, i) => ({
      id: `d${String(i).padStart(4, "0")}`, title: null, external_id: null,
      project_id: "p1", excluded_at: null, exclusion_pending_at: null,
    }));
    tableData.responses = Array.from({ length: 1001 }, (_, i) => ({
      id: `r${String(i).padStart(4, "0")}`, document_id: `d${String(i).padStart(4, "0")}`,
      project_id: "p1", respondent_type: "llm", is_latest: true,
      answers: {}, justifications: {}, answer_field_hashes: {}, created_at: "2026-01-01",
      schema_version_major: 1, schema_version_minor: 0, schema_version_patch: 0,
    }));
    let responseReads = 0;
    afterRead = (source) => {
      if (source === "responses" && ++responseReads === 1) tableData.responses.shift();
    };

    await renderPage();
    expect((captured.view?.summary as { totalLlmDocs: number }).totalLlmDocs).toBe(1001);
    expect(responseReads).toBe(2);
    expect(readCalls.filter((call) => call.table === "responses")[1].filters).toContainEqual(["gt", "id", "r0999"]);
  });

  it("consulta RPC por id e view por (documento, campo) além de 1000 linhas", async () => {
    tableData.projects = [{ id: "p1", pydantic_fields: [], schema_revision: 0, automation_mode: "auto_review_llm" }];
    tableData.final_answers = Array.from({ length: 1001 }, (_, i) => ({
      project_id: "p1", document_id: "d1", field_name: `f${String(i).padStart(4, "0")}`,
    }));
    rpcResults = { read_error_resolutions: { data: Array.from({ length: 1001 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}` })) } };

    await renderPage();
    expect(rpcCalls.filter((call) => call.fn === "read_error_resolutions")).toHaveLength(2);
    expect(readCalls.filter((call) => call.table === "final_answers")).toHaveLength(2);
    expect(readCalls.filter((call) => call.table === "final_answers")[1].filters).toContainEqual([
      "or", "", 'document_id.gt."d1",and(document_id.eq."d1",field_name.gt."f0999")',
    ]);
  });

  it("erro intermediário na RPC impede taxa calculada sobre dados parciais", async () => {
    rpcResults = { read_error_resolutions: [
      { data: Array.from({ length: 1000 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}` })) },
      { error: { message: "RPC interrompida" } },
    ] };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await renderPage();
    expect(html).toContain("Não foi possível carregar a taxa de erro do LLM agora.");
    expect(captured.view).toBeNull();
    consoleError.mockRestore();
  });
});
