import { describe, it, expect, beforeEach, vi } from "vitest";
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

const hoisted = vi.hoisted(() => ({
  isCoord: vi.fn<() => Promise<boolean>>(async () => true),
  adminFactory: vi.fn(),
}));

function makeClient() {
  return makeFilterAwareSupabaseMock({
    tableData,
    writeCalls: timeline as WriteCall[],
    rpcCalls: timeline as RpcCall[],
  });
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => authModuleMock(hoisted.isCoord));
vi.mock("@/lib/supabase/server", () => makeSupabaseServerModuleMock(makeClient));
vi.mock("@/lib/supabase/admin", () =>
  makeSupabaseAdminModuleMock(makeClient, hoisted.adminFactory),
);

beforeEach(() => {
  timeline = [];
  hoisted.isCoord.mockResolvedValue(true);
  hoisted.adminFactory.mockClear();
  tableData = {
    projects: [
      {
        id: "p1",
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

describe("regenerateAutoReviewBacklog — reconcile da fila", () => {
  it("reabre a fila depois de devolver field_reviews ao backlog", async () => {
    const regenerate = await loadRegenerate();

    const r = await regenerate("p1");

    expect(r.success).toBe(true);

    const reopenAt = timeline.findIndex(
      (s) => (s as RpcCall).fn === "reopen_auto_review_assignments_with_pending",
    );
    const upsertAt = timeline.findIndex(
      (s) =>
        (s as WriteCall).table === "field_reviews" &&
        (s as WriteCall).op === "upsert",
    );

    // Sem o reconcile, um campo devolvido ao backlog fica pendente num
    // documento que o upsert de assignments — que usa ignoreDuplicates — deixou
    // 'concluido'; o documento some da fila com veredito por fazer.
    expect(reopenAt).toBeGreaterThan(-1);
    expect(timeline[reopenAt]).toEqual({
      fn: "reopen_auto_review_assignments_with_pending",
      args: { p_project_id: "p1" },
    });
    // Antes do upsert, o reconcile não teria o que enxergar.
    expect(upsertAt).toBeGreaterThan(-1);
    expect(reopenAt).toBeGreaterThan(upsertAt);
  });
});
