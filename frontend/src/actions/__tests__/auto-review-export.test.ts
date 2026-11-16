import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyWithRef, loggedLine } from "@/test-utils/error-ref";

// Testa a server action getAutoReviewVerdicts: gate coordinator-only
// fail-closed, recorte do banco (projeto, veredito preenchido, arbitrados só
// com a opção) e o shape devolvido ao card.
import { makeFilterAwareSupabaseMock, type ReadCall, type WriteCall } from "@/test-utils/supabase-mock";

type Fixture = Pick<Parameters<typeof makeFilterAwareSupabaseMock>[0], "tableData" | "queryErrors">;
let readCalls: ReadCall[];
let writeCalls: WriteCall[];
let server: Fixture;

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
  createSupabaseServer: async () => makeFilterAwareSupabaseMock({ ...server, writeCalls, readCalls }),
}));

async function loadAction() {
  return (await import("@/actions/auto-review-export")).getAutoReviewVerdicts;
}

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/auto-review-export");
}, 30_000);

beforeEach(() => {
  readCalls = [];
  writeCalls = [];
  server = { tableData: {} };
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
  documents: { external_id: "N-1", title: "Doc" },
  // Colunas que a query filtra; o filtro do embed `documents!inner` é chave
  // literal da linha.
  project_id: "p1",
  "documents.excluded_at": null,
};

// Ciclos que a leitura precisa descartar: de outro projeto, sem veredito do
// pesquisador e em documento excluído.
const filteredOutCycles = [
  { ...reviewRow, id: "x-projeto", project_id: "p2" },
  { ...reviewRow, id: "x-sem-veredito", self_verdict: null },
  {
    ...reviewRow,
    id: "x-excluido",
    document_id: "d-excluido",
    documents: { external_id: "N-X", title: "Excluído" },
    "documents.excluded_at": "2026-01-01",
  },
];

function fixture(): Fixture {
  return {
    tableData: {
      projects: [
        { id: "p1", name: "Zolg", pydantic_fields: [{ name: "q_a", type: "text", hash: "hA" }] },
        { id: "p2", name: "Outro", pydantic_fields: [] },
      ],
      field_reviews: [
        reviewRow,
        { ...reviewRow, id: "fr2", self_reviewer_id: "u1" },
        { ...reviewRow, id: "fr3" },
        // Ciclo vigente fica de fora quando já foi substituído.
        { ...reviewRow, id: "x-substituido", superseded_at: "t" },
        ...filteredOutCycles,
      ],
      profiles: [
        { id: "u1", first_name: "Zeca", last_name: null, email: "z@x" },
        { id: "u2", first_name: null, last_name: null, email: "ana@x.com" },
      ],
    },
  };
}

const readsOf = (table: string) => readCalls.filter((c) => c.table === table);

describe("getAutoReviewVerdicts — gate", () => {
  it("devolve {error} para não-coordenador sem consultar dados", async () => {
    hoisted.requireCoordinator.mockResolvedValue({ ok: false, error: "negado" });
    const getAutoReviewVerdicts = await loadAction();
    expect(await getAutoReviewVerdicts("p1")).toEqual({ error: "negado" });
    expect(readCalls).toEqual([]);
    expect(hoisted.requireCoordinator).toHaveBeenCalledWith("p1", expect.any(String));
  });
});

describe("getAutoReviewVerdicts — leitura", () => {
  it("recorta pelo projeto, veredito preenchido e só ciclos vigentes por padrão", async () => {
    server = fixture();
    const getAutoReviewVerdicts = await loadAction();
    const result = await getAutoReviewVerdicts("p1");
    if ("error" in result) throw new Error(result.error);

    // Projeto, veredito preenchido, ciclo vigente e documento não excluído
    // (embutido com !inner): só os três ciclos de p1 passam.
    expect(result.reviews.map((r) => r.id)).toEqual(["fr1", "fr2", "fr3"]);
    expect(readsOf("field_reviews")[0]?.columns).toContain("documents!inner(external_id, title)");
    // Sem a opção, o histórico nem é lido.
    expect(readsOf("field_review_cycle_history_entries")).toEqual([]);
    // Os perfis lidos são só os dos pesquisadores dos ciclos.
    expect(readsOf("profiles").map((c) => c.filters)).toEqual([[["in", "id", ["u2", "u1"]]]]);
    expect(readCalls.every((c) => !c.columns.includes("*"))).toBe(true);

    expect(result.projectName).toBe("Zolg");
    // Leitura só: nenhuma escrita.
    expect(writeCalls).toEqual([]);
    expect(result.reviews[0]).not.toHaveProperty("documents");
    expect(result.documents).toEqual([{ id: "d1", external_id: "N-1", title: "Doc" }]);
    // Ordenados por nome; um id por pesquisador.
    expect(result.reviewers).toEqual([
      { id: "u2", name: "ana" },
      { id: "u1", name: "Zeca" },
    ]);
  });

  it("com includeArchived lê também o histórico, onde o banco guarda os ciclos arquivados", async () => {
    server = fixture();
    server.tableData.field_review_cycle_history_entries = [
      // Arquivado em outro documento: entra.
      { ...reviewRow, id: "h1", document_id: "d2", cycle_no: 1, superseded_at: "t", superseded_reason: "answer_changed", documents: { external_id: "N-2", title: "Doc 2" } },
      // Mesmo id de uma linha de field_reviews: a de field_reviews vence.
      { ...reviewRow, id: "fr1", self_verdict: "admite_erro", superseded_at: "t", superseded_reason: "answer_changed" },
      // O histórico também recorta projeto, veredito e documento excluído.
      ...filteredOutCycles.map((c) => ({ ...c, id: `h-${c.id}`, superseded_at: "t" })),
    ];
    const getAutoReviewVerdicts = await loadAction();
    const result = await getAutoReviewVerdicts("p1", { includeArchived: true });
    if ("error" in result) throw new Error(result.error);
    // Com a opção, o ciclo substituído que ainda está em field_reviews entra.
    expect(result.reviews.map((r) => r.id).sort()).toEqual(["fr1", "fr2", "fr3", "h1", "x-substituido"]);
    expect(result.reviews.find((r) => r.id === "fr1")?.self_verdict).toBe("ambiguo");
    expect(result.documents.map((d) => d.external_id).sort()).toEqual(["N-1", "N-2"]);
  });

  it("propaga erro de leitura do histórico", async () => {
    server = { ...fixture(), queryErrors: { "field_review_cycle_history_entries:select": { message: "sem histórico" } } };
    const getAutoReviewVerdicts = await loadAction();
    expect(await getAutoReviewVerdicts("p1", { includeArchived: true })).toEqual({ error: copyWithRef("Não foi possível carregar os vereditos da auto-revisão. Tente novamente.") });
  });

  it("só o true literal liga a opção vinda do cliente", async () => {
    server = fixture();
    const getAutoReviewVerdicts = await loadAction();
    const result = await getAutoReviewVerdicts("p1", { includeArchived: "sim" as unknown as boolean });
    if ("error" in result) throw new Error(result.error);
    expect(readsOf("field_review_cycle_history_entries")).toEqual([]);
    expect(result.reviews.map((r) => r.id)).not.toContain("x-substituido");
  });

  it("perfil ilegível mantém o pesquisador com o id", async () => {
    server = fixture();
    server.tableData.profiles = [];
    const getAutoReviewVerdicts = await loadAction();
    const result = await getAutoReviewVerdicts("p1");
    if ("error" in result) throw new Error(result.error);
    expect(result.reviewers.map((r) => r.name).sort()).toEqual(["u1", "u2"]);
  });

  it("sem ciclos não consulta perfis", async () => {
    server = fixture();
    server.tableData.field_reviews = [...filteredOutCycles];
    const getAutoReviewVerdicts = await loadAction();
    const result = await getAutoReviewVerdicts("p1");
    if ("error" in result) throw new Error(result.error);
    expect(result.reviewers).toEqual([]);
    expect(readsOf("profiles")).toEqual([]);
  });

  // O texto do Postgres ia cru ao toast pt-BR: vai ao log (#502).
  it("erro de leitura vira copy pt-BR, e o texto cru vai ao log", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    server = { ...fixture(), queryErrors: { "field_reviews:select": { message: "boom" } } };
    const getAutoReviewVerdicts = await loadAction();
    expect(await getAutoReviewVerdicts("p1")).toEqual({ error: copyWithRef("Não foi possível carregar os vereditos da auto-revisão. Tente novamente.") });
    expect(consoleError).toHaveBeenCalledWith(
      loggedLine("[auto-review-export] leitura falhou", { message: "boom" }),
    );
    consoleError.mockRestore();
  });
});
