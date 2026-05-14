import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock do Supabase: builder encadeavel cujo resultado por tabela e
// configurado por teste via `results`. Padrao alinhado a responses.test.ts.

interface QueryResult {
  data?: unknown;
  count?: number | null;
  error?: { message: string } | null;
}

let results: Record<string, QueryResult>;

beforeEach(() => {
  results = {};
});

function makeChain(result: QueryResult) {
  const r: QueryResult = { data: null, count: null, error: null, ...result };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "gt", "order", "limit", "range"]) {
    chain[m] = () => chain;
  }
  chain.maybeSingle = () => Promise.resolve(r);
  chain.single = () => Promise.resolve(r);
  // Thenable: `await query` (sem .single/.maybeSingle) resolve aqui.
  chain.then = (resolve: (v: QueryResult) => unknown) => resolve(r);
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => ({
    from: (table: string) =>
      makeChain(results[table] ?? { data: [], count: 0, error: null }),
  }),
}));

vi.mock("@/lib/api", () => ({
  fetchFastAPI: vi.fn(),
}));

async function loadLlm() {
  return import("@/actions/llm");
}

describe("getEligibleDocCount", () => {
  it("propaga erro da query de documents", async () => {
    results.documents = { error: { message: "rls documents" } };
    results.responses = { data: [] };
    const { getEligibleDocCount } = await loadLlm();
    await expect(getEligibleDocCount("p1", "pending")).rejects.toThrow(
      "rls documents"
    );
  });

  it("propaga erro da query de responses", async () => {
    results.documents = { count: 10 };
    results.responses = { error: { message: "rls responses" } };
    const { getEligibleDocCount } = await loadLlm();
    await expect(getEligibleDocCount("p1", "pending")).rejects.toThrow(
      "rls responses"
    );
  });

  it("caminho feliz retorna a contagem", async () => {
    results.documents = { count: 10 };
    results.responses = { data: [{ document_id: "d1" }] };
    const { getEligibleDocCount } = await loadLlm();
    await expect(getEligibleDocCount("p1", "all")).resolves.toEqual({
      total: 10,
      eligible: 10,
    });
  });
});

describe("getLlmRuns", () => {
  it("propaga erro", async () => {
    results.llm_runs = { error: { message: "boom runs" } };
    const { getLlmRuns } = await loadLlm();
    await expect(getLlmRuns("p1")).rejects.toThrow("boom runs");
  });

  it("caminho feliz retorna os registros", async () => {
    results.llm_runs = { data: [{ id: "r1" }, { id: "r2" }] };
    const { getLlmRuns } = await loadLlm();
    await expect(getLlmRuns("p1")).resolves.toHaveLength(2);
  });
});

describe("getRunningLlmCount", () => {
  it("propaga erro", async () => {
    results.llm_runs = { error: { message: "boom count" } };
    const { getRunningLlmCount } = await loadLlm();
    await expect(getRunningLlmCount("p1")).rejects.toThrow("boom count");
  });

  it("caminho feliz retorna o count", async () => {
    results.llm_runs = { count: 3 };
    const { getRunningLlmCount } = await loadLlm();
    await expect(getRunningLlmCount("p1")).resolves.toBe(3);
  });
});

describe("getLlmRunStats", () => {
  it("propaga erro das contagens", async () => {
    results.responses = { error: { message: "boom stats" } };
    const { getLlmRunStats } = await loadLlm();
    await expect(getLlmRunStats("job-1")).rejects.toThrow("boom stats");
  });

  it("caminho feliz retorna current e partial", async () => {
    results.responses = { count: 7 };
    const { getLlmRunStats } = await loadLlm();
    await expect(getLlmRunStats("job-1")).resolves.toEqual({
      current: 7,
      partial: 7,
    });
  });
});

describe("getLlmResponsesForProject", () => {
  it("propaga erro", async () => {
    results.responses = { error: { message: "boom resp" } };
    const { getLlmResponsesForProject } = await loadLlm();
    await expect(getLlmResponsesForProject("p1")).rejects.toThrow("boom resp");
  });

  it("caminho feliz mapeia os registros", async () => {
    results.responses = {
      data: [{ id: "x1", document_id: "d1", answers: null, documents: null }],
    };
    const { getLlmResponsesForProject } = await loadLlm();
    const res = await getLlmResponsesForProject("p1");
    expect(res).toHaveLength(1);
    expect(res[0].answers).toEqual({});
  });
});

describe("getRunningLlmJob", () => {
  it("propaga erro", async () => {
    results.llm_runs = { error: { message: "boom job" } };
    const { getRunningLlmJob } = await loadLlm();
    await expect(getRunningLlmJob("p1")).rejects.toThrow("boom job");
  });

  it("retorna null quando nao ha run ativa", async () => {
    results.llm_runs = { data: null };
    const { getRunningLlmJob } = await loadLlm();
    await expect(getRunningLlmJob("p1")).resolves.toBeNull();
  });

  it("caminho feliz retorna o job", async () => {
    results.llm_runs = {
      data: {
        job_id: "j1",
        started_at: "2026-05-14T00:00:00Z",
        heartbeat_at: "2026-05-14T00:01:00Z",
      },
    };
    const { getRunningLlmJob } = await loadLlm();
    await expect(getRunningLlmJob("p1")).resolves.toEqual({
      job_id: "j1",
      started_at: "2026-05-14T00:00:00Z",
    });
  });
});

describe("getDocumentsForSelection", () => {
  it("propaga erro da query de documents", async () => {
    results.documents = { error: { message: "boom docs" } };
    results.responses = { data: [] };
    const { getDocumentsForSelection } = await loadLlm();
    await expect(getDocumentsForSelection("p1")).rejects.toThrow("boom docs");
  });

  it("propaga erro da query de responses", async () => {
    results.documents = { data: [] };
    results.responses = { error: { message: "boom docs resp" } };
    const { getDocumentsForSelection } = await loadLlm();
    await expect(getDocumentsForSelection("p1")).rejects.toThrow(
      "boom docs resp"
    );
  });

  it("caminho feliz monta os itens de selecao", async () => {
    results.documents = {
      data: [{ id: "d1", title: "T", external_id: "E" }],
    };
    results.responses = {
      data: [{ document_id: "d1", respondent_type: "humano" }],
    };
    const { getDocumentsForSelection } = await loadLlm();
    await expect(getDocumentsForSelection("p1")).resolves.toEqual([
      {
        id: "d1",
        title: "T",
        external_id: "E",
        hasHumanResponse: true,
        llmResponseCount: 0,
      },
    ]);
  });
});
