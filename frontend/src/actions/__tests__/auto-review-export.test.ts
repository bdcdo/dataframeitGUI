import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Testa a server action getAutoReviewVerdicts: gate coordinator-only
// fail-closed, recorte do banco (projeto, veredito preenchido, arbitrados só
// com a opção) e o shape devolvido ao card.
import { makeSupabaseMock, type FilterCall, type TableResults } from "./supabase-mock";

let filterCalls: FilterCall[];
let selectCalls: Array<{ table: string; columns: string }>;
let serverTableResults: TableResults | undefined;

const hoisted = vi.hoisted(() => ({
  requireCoordinator: vi.fn<
    (
      projectId: string,
      deniedMessage: string,
    ) => Promise<{ ok: true; user: { id: string } } | { ok: false; error: string }>
  >(async () => ({ ok: true, user: { id: "userCoord" } })),
}));

vi.mock("@/lib/auth", () => ({
  requireCoordinator: (projectId: string, deniedMessage: string) =>
    hoisted.requireCoordinator(projectId, deniedMessage),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => {
    const client = makeSupabaseMock({ tableResults: serverTableResults, filterCalls });
    const from = client.from;
    client.from = (table: string) => {
      const builder = from(table);
      const select = builder.select as () => unknown;
      builder.select = (columns: string) => {
        selectCalls.push({ table, columns });
        return select();
      };
      return builder;
    };
    return client;
  },
}));

async function loadAction() {
  return (await import("@/actions/auto-review-export")).getAutoReviewVerdicts;
}

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/auto-review-export");
}, 30_000);

beforeEach(() => {
  filterCalls = [];
  selectCalls = [];
  serverTableResults = undefined;
  hoisted.requireCoordinator.mockResolvedValue({ ok: true, user: { id: "userCoord" } });
});

const reviewRow = {
  id: "fr1",
  document_id: "d1",
  field_name: "q_a",
  self_verdict: "ambiguo",
  self_justification: null,
  self_reviewer_id: "u2",
  human_answer_snapshot: "Sim",
  llm_answer_snapshot: "Não",
  llm_justification_snapshot: null,
  final_verdict: null,
  arbitrator_comment: null,
  field_hash: "hA",
  cycle_no: 1,
  superseded_at: null,
  superseded_reason: null,
};

function fixture(): TableResults {
  return {
    projects: { data: { name: "Zolg", pydantic_fields: [{ name: "q_a", type: "text", hash: "hA" }] } },
    documents: { data: [{ id: "d1", external_id: "N-1", title: "Doc" }] },
    field_reviews: {
      data: [reviewRow, { ...reviewRow, id: "fr2", self_reviewer_id: "u1" }, { ...reviewRow, id: "fr3" }],
    },
    profiles: {
      data: [
        { id: "u1", first_name: "Zeca", last_name: null, email: "z@x" },
        { id: "u2", first_name: null, last_name: null, email: "ana@x.com" },
      ],
    },
  };
}

describe("getAutoReviewVerdicts — gate", () => {
  it("devolve {error} para não-coordenador sem consultar dados", async () => {
    hoisted.requireCoordinator.mockResolvedValue({ ok: false, error: "negado" });
    const getAutoReviewVerdicts = await loadAction();
    expect(await getAutoReviewVerdicts("p1")).toEqual({ error: "negado" });
    expect(selectCalls).toEqual([]);
    expect(hoisted.requireCoordinator).toHaveBeenCalledWith("p1", expect.any(String));
  });
});

describe("getAutoReviewVerdicts — leitura", () => {
  it("recorta pelo projeto, veredito preenchido e só ciclos vigentes por padrão", async () => {
    serverTableResults = fixture();
    const getAutoReviewVerdicts = await loadAction();
    const result = await getAutoReviewVerdicts("p1");
    if ("error" in result) throw new Error(result.error);

    const reviewFilters = filterCalls.filter((c) => c.table === "field_reviews");
    expect(reviewFilters).toEqual(
      expect.arrayContaining([
        { table: "field_reviews", method: "eq", column: "project_id", value: "p1" },
        { table: "field_reviews", method: "not", column: "self_verdict", value: null },
        { table: "field_reviews", method: "is", column: "superseded_at", value: null },
      ]),
    );
    expect(filterCalls).toEqual(
      expect.arrayContaining([
        { table: "documents", method: "is", column: "excluded_at", value: null },
        { table: "profiles", method: "in", column: "id", value: ["u2", "u1"] },
      ]),
    );
    expect(selectCalls.every((c) => !c.columns.includes("*"))).toBe(true);

    expect(result.projectName).toBe("Zolg");
    expect(result.includeArchived).toBe(false);
    expect(result.reviews).toHaveLength(3);
    expect(result.documents).toEqual([{ id: "d1", external_id: "N-1", title: "Doc" }]);
    // Ordenados por nome; um id por pesquisador.
    expect(result.reviewers).toEqual([
      { id: "u2", name: "ana" },
      { id: "u1", name: "Zeca" },
    ]);
  });

  it("com includeArchived não filtra superseded_at", async () => {
    serverTableResults = fixture();
    const getAutoReviewVerdicts = await loadAction();
    const result = await getAutoReviewVerdicts("p1", { includeArchived: true });
    if ("error" in result) throw new Error(result.error);
    expect(result.includeArchived).toBe(true);
    expect(filterCalls.some((c) => c.table === "field_reviews" && c.column === "superseded_at")).toBe(false);
  });

  it("só o true literal liga a opção vinda do cliente", async () => {
    serverTableResults = fixture();
    const getAutoReviewVerdicts = await loadAction();
    const result = await getAutoReviewVerdicts("p1", { includeArchived: "sim" as unknown as boolean });
    if ("error" in result) throw new Error(result.error);
    expect(result.includeArchived).toBe(false);
  });

  it("perfil ilegível mantém o pesquisador com o id", async () => {
    serverTableResults = { ...fixture(), profiles: { data: [] } };
    const getAutoReviewVerdicts = await loadAction();
    const result = await getAutoReviewVerdicts("p1");
    if ("error" in result) throw new Error(result.error);
    expect(result.reviewers.map((r) => r.name).sort()).toEqual(["u1", "u2"]);
  });

  it("sem ciclos não consulta perfis", async () => {
    serverTableResults = { ...fixture(), field_reviews: { data: [] } };
    const getAutoReviewVerdicts = await loadAction();
    const result = await getAutoReviewVerdicts("p1");
    if ("error" in result) throw new Error(result.error);
    expect(result.reviewers).toEqual([]);
    expect(selectCalls.some((c) => c.table === "profiles")).toBe(false);
  });

  it("propaga erro de leitura", async () => {
    serverTableResults = { ...fixture(), field_reviews: { error: { message: "boom" } } };
    const getAutoReviewVerdicts = await loadAction();
    expect(await getAutoReviewVerdicts("p1")).toEqual({ error: "boom" });
  });
});
