import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeFilterAwareSupabaseMock,
  makeSupabaseAdminModuleMock,
  makeSupabaseServerModuleMock,
  type RpcCall,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { authModuleMock } from "@/test-utils/auth-mock";

let tableData: Record<string, unknown[]>;
let rpcCalls: RpcCall[];
let writeCalls: WriteCall[];

const coordinatorGate = vi.hoisted(() =>
  vi.fn<() => Promise<boolean>>(async () => true),
);
const adminFactory = vi.hoisted(() => vi.fn());

function makeClient() {
  return makeFilterAwareSupabaseMock({ tableData, rpcCalls, writeCalls });
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => authModuleMock(coordinatorGate));
vi.mock("@/lib/supabase/server", () =>
  makeSupabaseServerModuleMock(makeClient),
);
vi.mock("@/lib/supabase/admin", () =>
  makeSupabaseAdminModuleMock(makeClient, adminFactory),
);

beforeEach(() => {
  coordinatorGate.mockResolvedValue(true);
  adminFactory.mockClear();
  rpcCalls = [];
  writeCalls = [];
  tableData = {
    projects: [
      {
        id: "p1",
        pydantic_fields: [
          {
            name: "q1",
            type: "single",
            options: ["sim", "não"],
            target: "all",
          },
        ],
      },
    ],
    responses: [
      {
        id: "human-1",
        project_id: "p1",
        document_id: "doc-1",
        respondent_id: "member-1",
        respondent_type: "humano",
        is_latest: true,
        is_partial: false,
        answers: { q1: "sim" },
        answer_field_hashes: null,
      },
      {
        id: "llm-1",
        project_id: "p1",
        document_id: "doc-1",
        respondent_type: "llm",
        is_latest: true,
        answers: { q1: "não" },
        answer_field_hashes: null,
      },
    ],
    response_equivalences: [],
    field_reviews: [],
    assignments: [],
    // A RPC exige membership viva para cada respondente do lote; o produtor lê
    // a mesma lista para não emitir candidato que ela recusaria.
    project_members: [{ project_id: "p1", user_id: "member-1" }],
  };
});

describe("regenerateAutoReviewBacklog — escrita transacional em lote", () => {
  it("envia todos os candidatos por uma RPC e não faz upserts estruturais diretos", async () => {
    const { regenerateAutoReviewBacklog } = await import(
      "@/actions/field-reviews"
    );

    await expect(regenerateAutoReviewBacklog("p1")).resolves.toMatchObject({
      success: true,
      scanned: 1,
      regenerated: 1,
    });

    expect(rpcCalls).toEqual([
      {
        fn: "assign_auto_reviews_if_eligible",
        args: {
          p_candidates: [
            {
              human_response_id: "human-1",
              llm_response_id: "llm-1",
              field_names: ["q1"],
            },
          ],
        },
      },
      {
        fn: "reconcile_auto_review_assignments_with_pending",
        args: { p_project_id: "p1" },
      },
    ]);
    expect(writeCalls.filter((call) => call.op === "upsert")).toEqual([]);
    expect(adminFactory).toHaveBeenCalledTimes(1);
  });

  // Remover um membro apaga a membership e os assignments pendentes, mas
  // preserva as respostas. Enquanto elas viravam candidatas, a RPC recusava o
  // LOTE INTEIRO ('a resposta humana não pertence a um membro atual do
  // projeto'), e a regeneração ficava quebrada para sempre no projeto —
  // inclusive para quem continua membro.
  it("resposta de ex-membro não entra no lote nem bloqueia os membros atuais", async () => {
    tableData.responses.push(
      {
        id: "human-2",
        project_id: "p1",
        document_id: "doc-2",
        respondent_id: "ex-membro",
        respondent_type: "humano",
        is_latest: true,
        is_partial: false,
        answers: { q1: "sim" },
        answer_field_hashes: null,
      },
      {
        id: "llm-2",
        project_id: "p1",
        document_id: "doc-2",
        respondent_type: "llm",
        is_latest: true,
        answers: { q1: "não" },
        answer_field_hashes: null,
      },
    );

    const { regenerateAutoReviewBacklog } = await import(
      "@/actions/field-reviews"
    );

    await expect(regenerateAutoReviewBacklog("p1")).resolves.toMatchObject({
      success: true,
      regenerated: 1,
    });

    const assignCall = rpcCalls.find(
      (call) => call.fn === "assign_auto_reviews_if_eligible",
    );
    expect(assignCall?.args).toEqual({
      p_candidates: [
        {
          human_response_id: "human-1",
          llm_response_id: "llm-1",
          field_names: ["q1"],
        },
      ],
    });
  });
});
