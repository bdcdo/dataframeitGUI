import { groupValueEquivalencesByField } from "@/lib/equivalence";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const computeBacklogRows = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  due: true,
  llmLatest: true,
  humanLatest: true,
  rpcError: null as string | null,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  // Efeito colateral disparado DENTRO da reconciliação, que é onde a corrida
  // vive: entre o commit da RPC e o ACK, uma nova submissão humana reenfileira
  // o documento com a mesma geração LLM.
  rpcSideEffect: null as (() => void) | null,
  failures: [] as unknown[],
  deletes: [] as Array<Array<[string, unknown]>>,
  // Filtros das LEITURAS, não só das escritas: é o que permite afirmar que o
  // worker busca a geração LLM pelo id enfileirado, e não a corrente do
  // documento — a diferença entre reconciliar a geração certa e reconciliar
  // outra com os `expected_*` da antiga.
  selects: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  // Equivalências de valor do PROJETO (`value_equivalences`): o worker as lê
  // sem filtro de documento.
  equivalences: [] as Array<Record<string, unknown>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auto-review-backlog", () => ({ computeBacklogRows }));

class Query {
  private filters: Array<[string, unknown]> = [];
  private operation: "select" | "delete" = "select";
  private head = false;

  constructor(private table: string) {}

  select(_columns?: string, options?: { head?: boolean }) {
    this.head = options?.head ?? false;
    return this;
  }
  order() { return this; }
  range() { return this; }
  limit() { return this; }
  lte() { return this; }
  single() { return this; }
  maybeSingle() { return this; }
  is(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  delete() { this.operation = "delete"; return this; }

  private deleteResult() {
    state.deletes.push(this.filters);
    state.requests = state.requests.filter((request) =>
      !this.filters.every(([column, value]) => request[column] === value),
    );
    return { data: null, error: null };
  }

  private requestsResult() {
    if (this.head) {
      return { data: null, count: state.due ? state.requests.length : 0, error: null };
    }
    return { data: state.due ? state.requests : [], error: null };
  }

  private responsesResult() {
    const isLlm = this.filters.some(
      ([column, value]) => column === "respondent_type" && value === "llm",
    );
    if (isLlm) {
      return {
        data: state.llmLatest
          ? {
              id: "llm-1",
              document_id: "doc-1",
              answers: { q1: "llm" },
              answer_field_hashes: {},
              updated_at: "2026-07-16T12:00:00.000Z",
            }
          : null,
        error: null,
      };
    }
    return {
      data: state.humanLatest ? [{
        id: "human-1",
        document_id: "doc-1",
        respondent_id: "user-1",
        answers: { q1: "human" },
        answer_field_hashes: {},
        updated_at: "2026-07-16T11:00:00.000Z",
      }] : [],
      error: null,
    };
  }

  private selectResult() {
    state.selects.push({ table: this.table, filters: this.filters });
    if (this.table === "auto_review_reconciliation_requests") return this.requestsResult();
    if (this.table === "responses") return this.responsesResult();
    const rowsByTable: Record<string, unknown> = {
      projects: {
        pydantic_fields: [{ name: "q1", type: "text", target: "all", hash: "h" }],
        pydantic_hash: "schema-hash",
      },
      value_equivalences: state.equivalences,
      field_reviews: [],
      field_review_cycle_history_entries: [{ self_reviewer_id: "user-1" }],
      member_email_links: [],
      project_members: [{ user_id: "user-1" }],
    };
    if (!(this.table in rowsByTable)) throw new Error(`Tabela inesperada: ${this.table}`);
    return { data: rowsByTable[this.table], error: null };
  }

  private result() {
    return this.operation === "delete" ? this.deleteResult() : this.selectResult();
  }

  then(resolve: (value: unknown) => unknown) {
    return Promise.resolve(this.result()).then(resolve);
  }
}

const admin = {
  from: (table: string) => new Query(table),
  rpc: vi.fn(async (name: string, args: unknown) => {
    state.rpcCalls.push({ name, args });
    if (name === "record_auto_review_reconciliation_failure") {
      state.failures.push(args);
      state.due = false;
      return { data: true, error: null };
    }
    if (name === "reconcile_auto_review_cycles") state.rpcSideEffect?.();
    return {
      data: {},
      error: state.rpcError ? { message: state.rpcError } : null,
    };
  }),
};

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => admin,
}));

const request = {
  project_id: "project-1",
  document_id: "doc-1",
  llm_response_id: "llm-1",
  requested_at: "2026-07-16T12:30:00.000Z",
  allow_new_cycles: true,
};

beforeEach(() => {
  state.requests = [{ ...request }];
  state.due = true;
  state.llmLatest = true;
  state.humanLatest = true;
  state.rpcError = null;
  state.rpcCalls = [];
  state.rpcSideEffect = null;
  state.failures = [];
  state.deletes = [];
  state.selects = [];
  state.equivalences = [];
  admin.rpc.mockClear();
  computeBacklogRows.mockReset();
  computeBacklogRows.mockReturnValue({
    regenerated: 1,
    fieldReviewRows: [{
      project_id: "project-1",
      document_id: "doc-1",
      field_name: "q1",
      human_response_id: "human-1",
      llm_response_id: "llm-1",
      self_reviewer_id: "user-1",
    }],
  });
});

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/lib/auto-review-reconciler");
}, 30_000);

describe("drainAutoReviewReconciliationRequests", () => {
  it("reutiliza o cálculo canônico, reconcilia e confirma a request exata", async () => {
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    const result = await drainAutoReviewReconciliationRequests();

    expect(result).toEqual({ processed: 1, stale: 0, failed: 0, remaining: 0 });
    expect(computeBacklogRows).toHaveBeenCalledOnce();
    expect(state.rpcCalls).toEqual([{
      name: "reconcile_auto_review_cycles",
      args: { p_groups: [{
        human_response_id: "human-1",
        llm_response_id: "llm-1",
        field_names: ["q1"],
        divergent_field_names: ["q1"],
        expected_human_updated_at: "2026-07-16T11:00:00.000Z",
        expected_llm_updated_at: "2026-07-16T12:00:00.000Z",
        expected_project_pydantic_hash: "schema-hash",
        expected_equivalence_ids: [],
      }] },
    }]);
    expect(state.deletes[0]).toContainEqual(["llm_response_id", "llm-1"]);
  });

  it("não confirma a request que um save humano reenfileirou durante a reconciliação", async () => {
    // A janela é estreita mas a perda é silenciosa: a RPC já commitou os
    // field_reviews, o novo save os arquiva e reenfileira o documento, e um ACK
    // que casasse só documento+geração apagaria esse pedido recém-criado — o
    // reenfileiramento humano mantém a MESMA geração LLM, só `requested_at`
    // muda. O documento ficaria com as revisões arquivadas e nada na fila para
    // regenerá-las, invisível até a próxima publicação LLM.
    const reenqueued = { ...request, requested_at: "2026-07-16T12:31:00.000Z" };
    state.rpcSideEffect = () => { state.requests = [reenqueued]; };
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    const result = await drainAutoReviewReconciliationRequests();

    // A perda vem primeiro: é o dado sobrevivendo que interessa, não a forma da
    // query. O filtro logo abaixo diz por qual coluna ela sobreviveu.
    expect(state.requests).toEqual([reenqueued]);
    expect(result).toEqual({ processed: 1, stale: 0, failed: 0, remaining: 1 });
    expect(state.deletes[0]).toContainEqual(["requested_at", "2026-07-16T12:30:00.000Z"]);
  });

  it("também reconcilia consenso para encerrar um ciclo anterior", async () => {
    computeBacklogRows.mockReturnValue({ regenerated: 0, fieldReviewRows: [] });
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    await drainAutoReviewReconciliationRequests();

    expect(state.rpcCalls[0]).toEqual({
      name: "reconcile_auto_review_cycles",
      args: { p_groups: [expect.objectContaining({ divergent_field_names: [] })] },
    });
  });

  it("descarta request obsoleta sem reconciliar", async () => {
    state.llmLatest = false;
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    const result = await drainAutoReviewReconciliationRequests();

    expect(result).toEqual({ processed: 0, stale: 1, failed: 0, remaining: 0 });
    expect(state.rpcCalls).toEqual([]);
    expect(state.deletes[0]).toContainEqual(["llm_response_id", "llm-1"]);
    // Obsoleta é descartada, não reagendada: desde a #670 nada volta para a
    // fila esperando uma geração que já foi substituída (era o retry perpétuo).
    expect(state.failures).toEqual([]);
  });

  it("mantém a request e registra a falha para retry", async () => {
    state.rpcError = "lock timeout";
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    const result = await drainAutoReviewReconciliationRequests();

    expect(result).toEqual({ processed: 0, stale: 0, failed: 1, remaining: 0 });
    expect(state.deletes).toEqual([]);
    expect(state.failures).toEqual([{
      p_document_id: "doc-1",
      p_llm_response_id: "llm-1",
      p_error: "lock timeout",
    }]);
  });

  it("lê a resposta LLM pela geração enfileirada, não pela corrente do documento", async () => {
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    await drainAutoReviewReconciliationRequests();

    const llmRead = state.selects.find(
      (s) => s.table === "responses"
        && s.filters.some(([column, value]) => column === "respondent_type" && value === "llm"),
    );
    expect(llmRead?.filters).toContainEqual(["id", "llm-1"]);
  });

  it("confirma uma geração LLM sem humano e deixa um save futuro reenfileirar", async () => {
    state.humanLatest = false;
    computeBacklogRows.mockReturnValue({ regenerated: 0, fieldReviewRows: [] });

    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    const result = await drainAutoReviewReconciliationRequests();

    expect(result.processed).toBe(1);
  });
});

describe("expectedEquivalenceIds", () => {
  const eq = (id: string, field_name: string, a: string, b: string, field_hash = "h") => ({
    id, field_name, field_hash, value_a: a, value_b: b, reviewer_id: null,
  });
  const fields = [
    { name: "q1", type: "text", hash: "h" },
    { name: "q2", type: "text", hash: "h" },
  ] as never;

  it("só as das classes dos valores do humano e do LLM, na versão atual, em ordem de id", async () => {
    const { expectedEquivalenceIds } = await import("@/lib/auto-review-reconciler");
    expect(expectedEquivalenceIds(
      groupValueEquivalencesByField([
        eq("c3", "q1", "NI", "N/A"),
        // Mesma classe por transitividade: desfazê-la separa os valores.
        eq("b2", "q1", "N/A", "não se aplica"),
        // Outros valores do mesmo campo: não pertencem a este documento.
        eq("a1", "q1", "sim", "yes"),
        // Outra versão da pergunta e campo fora do schema.
        eq("d4", "q2", "x", "y", "velho"),
        eq("e5", "q9", "NI", "N/A"),
      ]),
      fields,
      { q1: "NI", q2: "x" },
      { q1: "não se aplica", q2: "y" },
    )).toEqual(["b2", "c3"]);
  });
});

describe("drainAutoReviewReconciliationRequests: equivalências de valor", () => {
  it("lê as do projeto sem filtro de documento e as manda como versão esperada", async () => {
    state.equivalences = [
      { id: "eq-b", field_name: "q1", field_hash: "h", value_a: "human", value_b: "llm", reviewer_id: null },
      { id: "eq-a", field_name: "q1", field_hash: "h", value_a: "x", value_b: "y", reviewer_id: null },
      { id: "eq-z", field_name: "fora", field_hash: "h", value_a: "x", value_b: "y", reviewer_id: null },
    ];
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    await drainAutoReviewReconciliationRequests();

    const read = state.selects.find((select) => select.table === "value_equivalences");
    expect(read?.filters).toEqual([["project_id", "project-1"]]);
    const equivalencesByField = computeBacklogRows.mock.calls[0][3] as Map<string, unknown[]>;
    expect(equivalencesByField.get("q1")).toHaveLength(2);
    // Só a da classe dos valores do par (human = llm); eq-a é de outros valores.
    expect(state.rpcCalls[0]).toEqual({
      name: "reconcile_auto_review_cycles",
      args: { p_groups: [expect.objectContaining({ expected_equivalence_ids: ["eq-b"] })] },
    });
  });

  it("lê as equivalências do projeto uma vez por drenagem", async () => {
    state.requests = [
      { ...request },
      { ...request, document_id: "doc-2", requested_at: "2026-07-16T12:31:00.000Z" },
    ];
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    await drainAutoReviewReconciliationRequests();

    expect(state.rpcCalls.filter((call) => call.name === "reconcile_auto_review_cycles")).toHaveLength(2);
    expect(state.selects.filter((select) => select.table === "value_equivalences")).toHaveLength(1);
  });
});
