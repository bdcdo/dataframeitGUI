import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBlindVerdict } from "@/lib/arbitration-order";
import {
  makeSupabaseMock,
  type RpcCall,
  type TableResults,
} from "./supabase-mock";

let rpcCalls: RpcCall[];
let rpcResults: Record<string, { data?: unknown; error?: { message: string } | null }>;
let serverTableResults: TableResults;
let adminTableResults: TableResults;
let adminCreateCalls: number;

const hoisted = vi.hoisted(() => ({
  requireCoordinator: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "account1" }),
  getEffectiveMemberId: async () => "member1",
  requireCoordinator: hoisted.requireCoordinator,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({ rpcCalls, rpcResults, tableResults: serverTableResults }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => {
    adminCreateCalls++;
    return makeSupabaseMock({
      rpcCalls,
      rpcResults,
      tableResults: adminTableResults,
      defaultResult: { data: [] },
    });
  },
}));

beforeEach(() => {
  rpcCalls = [];
  rpcResults = {};
  serverTableResults = {};
  adminTableResults = {
    responses: { data: [] },
    project_members: { data: [] },
    assignments: { data: [] },
  };
  adminCreateCalls = 0;
  hoisted.requireCoordinator.mockReset();
  hoisted.requireCoordinator.mockResolvedValue({ ok: false, error: "não usado" });
});

async function actions() {
  return import("@/actions/field-reviews");
}

describe("submitAutoReview", () => {
  it("recusa justificativa vazia antes da RPC", async () => {
    const { submitAutoReview } = await actions();
    const result = await submitAutoReview("p1", "d1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "contesta_llm" },
    ]);

    expect(result.error).toContain("justificativa obrigatória");
    expect(rpcCalls).toEqual([]);
  });

  it("envia somente o contrato mínimo, com identidade efetiva e texto trimado", async () => {
    rpcResults.submit_self_review = {
      data: { updatedCount: 1, needsArbitrator: [] },
    };
    const { submitAutoReview } = await actions();
    const result = await submitAutoReview("p1", "d1", [
      {
        fieldReviewId: "fr1",
        fieldName: "q1",
        verdict: "ambiguo",
        justification: "  enunciado incompleto  ",
      },
    ]);

    expect(result).toEqual({ success: true, arbitrated: 0, warning: undefined });
    expect(rpcCalls).toContainEqual({
      fn: "submit_self_review",
      args: {
        p_project_id: "p1",
        p_document_id: "d1",
        p_reviewer_id: "member1",
        p_decisions: [
          {
            fieldReviewId: "fr1",
            verdict: "ambiguo",
            justification: "enunciado incompleto",
          },
        ],
      },
    });
  });

  it("avisa quando a RPC devolve contestação e não existe árbitro elegível", async () => {
    rpcResults.submit_self_review = {
      data: {
        updatedCount: 1,
        needsArbitrator: [{ fieldReviewId: "fr1", fieldName: "q1" }],
      },
    };
    const { submitAutoReview } = await actions();
    const result = await submitAutoReview("p1", "d1", [
      {
        fieldReviewId: "fr1",
        fieldName: "q1",
        verdict: "contesta_llm",
        justification: "discordo",
      },
    ]);

    expect(result.success).toBe(true);
    expect(result.arbitrated).toBe(0);
    expect(result.warning).toContain("Não há árbitros elegíveis");
    expect(adminCreateCalls).toBe(1);
  });

  it("usa o cliente privilegiado somente para a RPC de atribuição", async () => {
    rpcResults.submit_self_review = {
      data: {
        needsArbitrator: [{ fieldReviewId: "fr1", fieldName: "q1" }],
      },
    };
    rpcResults.assign_arbitration_if_eligible = { data: 1 };
    serverTableResults = {
      responses: { data: [] },
      project_members: {
        data: [{ user_id: "arbitrator1", role: "pesquisador" }],
      },
      assignments: { data: [] },
    };
    const { submitAutoReview } = await actions();

    const result = await submitAutoReview("p1", "d1", [
      {
        fieldReviewId: "fr1",
        fieldName: "q1",
        verdict: "contesta_llm",
        justification: "discordo",
      },
    ]);

    expect(result).toMatchObject({ success: true, arbitrated: 1 });
    expect(adminCreateCalls).toBe(1);
    expect(rpcCalls).toContainEqual({
      fn: "assign_arbitration_if_eligible",
      args: {
        p_project_id: "p1",
        p_document_id: "d1",
        p_user_id: "arbitrator1",
        p_field_names: ["q1"],
      },
    });
  });
});

describe("retryPendingArbitrations", () => {
  it("cria um único cliente privilegiado para drenar todo o backlog", async () => {
    hoisted.requireCoordinator.mockResolvedValueOnce({
      ok: true,
      user: { id: "coord1" },
    });
    rpcResults.assign_arbitration_if_eligible = { data: 1 };
    serverTableResults = {
      field_reviews: {
        data: [
          {
            document_id: "d1",
            field_name: "q1",
            self_reviewer_id: "member1",
          },
          {
            document_id: "d2",
            field_name: "q2",
            self_reviewer_id: "member2",
          },
        ],
      },
      responses: { data: [] },
      project_members: {
        data: [{ user_id: "arbitrator1", role: "pesquisador" }],
      },
      assignments: { data: [] },
    };
    const { retryPendingArbitrations } = await actions();

    expect(await retryPendingArbitrations("p1")).toEqual({
      success: true,
      assigned: 2,
      stillNoPool: 0,
    });
    expect(adminCreateCalls).toBe(1);
  });
});

describe("regenerateAutoReviewBacklog", () => {
  beforeEach(() => {
    hoisted.requireCoordinator.mockResolvedValue({
      ok: true,
      user: { id: "account1" },
      effectiveUserId: "member1",
    });
    serverTableResults = {
      projects: {
        data: {
          pydantic_fields: [
            {
              name: "campo1",
              type: "text",
              options: null,
              description: "Campo de teste",
            },
          ],
        },
      },
      responses: [
        {
          data: [
            {
              id: "human1",
              document_id: "doc1",
              respondent_id: "member1",
              answers: { campo1: "sim" },
              answer_field_hashes: null,
            },
          ],
        },
        {
          data: [
            {
              id: "llm1",
              document_id: "doc1",
              answers: { campo1: "não" },
              answer_field_hashes: null,
            },
          ],
        },
      ],
      response_equivalences: { data: [] },
      field_reviews: { data: [] },
      project_members: { data: [{ user_id: "member1" }] },
    };
    rpcResults.reconcile_auto_review_backlog = { data: 0 };
  });

  it("envia o conjunto canônico à RPC service-only", async () => {
    const { regenerateAutoReviewBacklog } = await actions();

    await expect(regenerateAutoReviewBacklog("p1")).resolves.toEqual({
      success: true,
      scanned: 1,
      regenerated: 1,
      removed: 0,
      keptResolved: 0,
    });
    expect(rpcCalls).toContainEqual({
      fn: "reconcile_auto_review_backlog",
      args: {
        p_project_id: "p1",
        p_actor_id: "account1",
        p_field_review_rows: [
          {
            document_id: "doc1",
            field_name: "campo1",
            human_response_id: "human1",
            llm_response_id: "llm1",
            self_reviewer_id: "member1",
          },
        ],
        p_ids_to_delete: [],
      },
    });
    expect(adminCreateCalls).toBe(1);
  });

  it("propaga falha da RPC sem anunciar reconciliação parcial", async () => {
    rpcResults.reconcile_auto_review_backlog = {
      error: { message: "coordinator, creator, or master required" },
    };
    const { regenerateAutoReviewBacklog } = await actions();

    await expect(regenerateAutoReviewBacklog("p1")).resolves.toEqual({
      success: false,
      error: "coordinator, creator, or master required",
    });
  });
});

describe("submitBlindVerdicts", () => {
  it("traduz A/B no servidor e envia uma única RPC", async () => {
    const { submitBlindVerdicts } = await actions();
    const result = await submitBlindVerdicts("p1", "d1", [
      { fieldReviewId: "fr1", choice: "a" },
    ]);

    expect(result).toEqual({ success: true });
    expect(rpcCalls).toContainEqual({
      fn: "submit_blind_arbitration",
      args: {
        p_project_id: "p1",
        p_document_id: "d1",
        p_arbitrator_id: "member1",
        p_decisions: [
          {
            fieldReviewId: "fr1",
            verdict: resolveBlindVerdict("fr1", "a"),
          },
        ],
      },
    });
  });
});

describe("submitFinalVerdicts", () => {
  it("exige sugestão quando o LLM vence", async () => {
    const { submitFinalVerdicts } = await actions();
    const result = await submitFinalVerdicts("p1", "d1", [
      { fieldReviewId: "fr1", fieldName: "q1", verdict: "llm" },
    ]);

    expect(result.error).toContain("sugestão de melhoria obrigatória");
    expect(rpcCalls).toEqual([]);
  });

  it("identifica a linha por fieldReviewId e normaliza os textos", async () => {
    const { submitFinalVerdicts } = await actions();
    const result = await submitFinalVerdicts("p1", "d1", [
      {
        fieldReviewId: "fr1",
        fieldName: "q1",
        verdict: "llm",
        questionImprovementSuggestion: "  esclarecer o período  ",
        arbitratorComment: "  mantido  ",
      },
    ]);

    expect(result).toEqual({ success: true });
    expect(rpcCalls).toContainEqual({
      fn: "submit_final_arbitration",
      args: {
        p_project_id: "p1",
        p_document_id: "d1",
        p_arbitrator_id: "member1",
        p_decisions: [
          {
            fieldReviewId: "fr1",
            verdict: "llm",
            questionImprovementSuggestion: "esclarecer o período",
            arbitratorComment: "mantido",
          },
        ],
      },
    });
  });
});
