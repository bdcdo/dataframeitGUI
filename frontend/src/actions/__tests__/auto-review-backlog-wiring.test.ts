import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseAdminModuleMock,
  makeSupabaseServerModuleMock,
  makeFilterAwareSupabaseMock,
  type RpcCall,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { authModuleMock } from "@/test-utils/auth-mock";

// Fiação de regenerateAutoReviewBacklog com o reconcile da fila. Arquivo
// separado de arbitration-retry.test.ts porque este caminho lê `responses` duas
// vezes na mesma tabela (humano vs LLM, discriminados por respondent_type), o
// que exige o mock filter-aware — o simples devolveria a mesma linha para os
// dois e nunca produziria divergência.

// Uma lista só para escritas e RPCs: o que este teste fixa é a ORDEM entre elas
// (o reconcile só reabre o que o upsert de field_reviews já devolveu ao
// backlog), e arrays separados não a capturariam.
type Step = WriteCall | RpcCall;
let timeline: Step[];
let tableData: Record<string, unknown[]>;
let queryErrors: Record<string, { message: string } | null>;

const hoisted = vi.hoisted(() => ({
  isCoord: vi.fn<() => Promise<boolean>>(async () => true),
  adminFactory: vi.fn(),
  drain: vi.fn(async () => ({
    processed: 1,
    stale: 0,
    failed: 0,
    remaining: 0,
  })),
}));

function makeClient() {
  return makeFilterAwareSupabaseMock({
    tableData,
    writeCalls: timeline as WriteCall[],
    rpcCalls: timeline as RpcCall[],
    queryErrors,
  });
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => authModuleMock(hoisted.isCoord));
vi.mock("@/lib/supabase/server", () => makeSupabaseServerModuleMock(makeClient));
vi.mock("@/lib/supabase/admin", () =>
  makeSupabaseAdminModuleMock(makeClient, hoisted.adminFactory),
);
vi.mock("@/lib/auto-review-reconciler", () => ({
  drainAutoReviewReconciliationRequests: hoisted.drain,
}));

beforeEach(() => {
  timeline = [];
  queryErrors = {};
  hoisted.isCoord.mockResolvedValue(true);
  hoisted.adminFactory.mockClear();
  hoisted.drain.mockClear();
  tableData = {
    projects: [
      {
        id: "p1",
        automation_mode: "auto_review_llm",
        pydantic_fields: [
          { name: "q1", type: "single", options: ["a", "b"], target: "all" },
        ],
      },
    ],
    // Humano diverge do LLM em q1 → o backlog tem uma linha para materializar.
    responses: [
      {
        id: "h1",
        project_id: "p1",
        document_id: "d1",
        respondent_id: "u1",
        respondent_type: "humano",
        is_latest: true,
        is_partial: false,
        answers: { q1: "a" },
        answer_field_hashes: null,
      },
      {
        id: "l1",
        project_id: "p1",
        document_id: "d1",
        respondent_type: "llm",
        is_latest: true,
        is_partial: false,
        answers: { q1: "b" },
        answer_field_hashes: null,
      },
    ],
    response_equivalences: [],
    field_reviews: [],
    assignments: [],
  };
});

async function loadRegenerate() {
  return (await import("@/actions/field-reviews")).regenerateAutoReviewBacklog;
}

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/field-reviews");
}, 30_000);

describe("regenerateAutoReviewBacklog — reconcile da fila", () => {
  it("reenfileira o projeto e usa somente o dreno canônico", async () => {
    const regenerate = await loadRegenerate();

    const r = await regenerate("p1");

    expect(r.success).toBe(true);

    expect(timeline).toContainEqual({
      fn: "enqueue_auto_review_reconciliation_for_project",
      args: {
        p_project_id: "p1",
      },
    });
    expect(timeline.some(
      (step) => (step as RpcCall).fn === "reconcile_auto_review_cycles",
    )).toBe(false);
    expect(hoisted.drain).toHaveBeenCalledWith({ projectId: "p1", maxRequests: 2_000 });
    expect(timeline.some((step) => (step as WriteCall).table === "assignments")).toBe(false);
    expect(timeline.some((step) => (step as WriteCall).table === "field_reviews")).toBe(false);
    expect(r.withoutLlm).toBe(0);
  });

  // #690: round reiniciado arquiva a geração LLM, a RPC casa zero documentos, e
  // o resultado precisa dizer quantos ficaram fora em vez de só "0".
  it("devolve quantos documentos ficaram fora por não ter geração LLM corrente", async () => {
    tableData.responses = tableData.responses.map((row) =>
      (row as { respondent_type: string }).respondent_type === "llm"
        ? { ...(row as object), is_latest: false }
        : row,
    );
    const regenerate = await loadRegenerate();

    const r = await regenerate("p1");

    expect(r).toMatchObject({ success: true, withoutLlm: 1 });
  });

  it("falha da contagem não derruba o reparo: vira null", async () => {
    queryErrors = { "responses:select": { message: "boom" } };
    const regenerate = await loadRegenerate();

    const r = await regenerate("p1");

    expect(r).toMatchObject({ success: true, withoutLlm: null });
  });
});
