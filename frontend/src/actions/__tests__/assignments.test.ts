import { describe, it, expect, beforeEach, vi } from "vitest";

// Regressão da issue #182: getLotteryDocStats (path de exibição do dialog de
// sorteio) passa a ler a view agregada `lottery_doc_stats` em vez de fazer
// fetch bruto de responses/assignments do projeto inteiro. O teste trava o
// ganho garantindo que essas tabelas não são mais tocadas nesse path.
import {
  makeSupabaseMock,
  type TableResults,
} from "./supabase-mock";

let serverTableResults: TableResults | undefined;
let fromCalls: string[];

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "user-1", isMaster: false }),
  resolveProjectActor: async () => ({
    ok: true,
    user: { id: "user-1", isMaster: false },
    effectiveUserId: "member-1",
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => {
    const mock = makeSupabaseMock({ tableResults: serverTableResults });
    return {
      ...mock,
      from: (table: string) => {
        fromCalls.push(table);
        return mock.from(table);
      },
    };
  },
}));

import { getLotteryDocStats, previewLottery } from "../assignments";

beforeEach(() => {
  serverTableResults = undefined;
  fromCalls = [];
});

describe("getLotteryDocStats", () => {
  it("mapeia as linhas da view lottery_doc_stats para LotteryDocStats[]", async () => {
    serverTableResults = {
      lottery_doc_stats: {
        data: [
          {
            id: "d1",
            external_id: "EXT-1",
            title: "Doc 1",
            human_coding_count: 2,
            has_llm_response: true,
            active_codificacao: 1,
            active_comparacao: 0,
            has_any_assignment_ever: true,
            batch_ids: ["b1", "b2"],
          },
          {
            id: "d2",
            external_id: null,
            title: "Doc 2",
            human_coding_count: 0,
            has_llm_response: false,
            active_codificacao: 0,
            active_comparacao: 0,
            has_any_assignment_ever: false,
            batch_ids: null,
          },
        ],
      },
      assignment_batches: {
        data: [{ id: "b1", label: "Lote 1", created_at: "2026-01-01" }],
      },
      projects: {
        data: { min_responses_for_comparison: 2, automation_mode: "compare_llm" },
      },
    };

    const result = await getLotteryDocStats("p1");

    expect(result.error).toBeUndefined();
    expect(result.docs).toEqual([
      {
        id: "d1",
        externalId: "EXT-1",
        title: "Doc 1",
        humanCodingCount: 2,
        hasLlmResponse: true,
        activeAssignments: { codificacao: 1, comparacao: 0 },
        hasAnyAssignmentEver: true,
        batchIds: ["b1", "b2"],
      },
      {
        id: "d2",
        externalId: null,
        title: "Doc 2",
        humanCodingCount: 0,
        hasLlmResponse: false,
        activeAssignments: { codificacao: 0, comparacao: 0 },
        hasAnyAssignmentEver: false,
        batchIds: [],
      },
    ]);
    expect(result.minResponsesForComparison).toBe(2);
    expect(result.automationMode).toBe("compare_llm");
  });

  it("não consulta responses nem assignments crus (regressão da issue #182)", async () => {
    serverTableResults = {
      lottery_doc_stats: { data: [] },
      assignment_batches: { data: [] },
      projects: { data: { min_responses_for_comparison: 2, automation_mode: null } },
    };

    await getLotteryDocStats("p1");

    expect(fromCalls).toContain("lottery_doc_stats");
    expect(fromCalls).not.toContain("responses");
    expect(fromCalls).not.toContain("assignments");
  });
});

describe("previewLottery", () => {
  it("caminho feliz: distribui documentos elegíveis a partir da view + assignments brutos", async () => {
    serverTableResults = {
      project_members: { data: [{ user_id: "u1" }] },
      lottery_doc_stats: {
        data: [
          {
            id: "d1",
            external_id: "EXT-1",
            title: "Doc 1",
            human_coding_count: 0,
            has_llm_response: false,
            active_codificacao: 0,
            active_comparacao: 0,
            has_any_assignment_ever: false,
            batch_ids: [],
          },
        ],
      },
      assignment_batches: { data: [] },
      projects: { data: { min_responses_for_comparison: 2, automation_mode: null } },
      assignments: { data: [] },
    };

    const result = await previewLottery({
      projectId: "p1",
      type: "codificacao",
      mode: "append",
      balancing: "round",
      researchersPerDoc: 1,
      participantIds: ["u1"],
    });

    expect(result.error).toBeUndefined();
    expect(result.preview?.totalNew).toBe(1);
    expect(result.preview?.eligibleDocs).toBe(1);
    expect(result.preview?.participants).toEqual([
      { userId: "u1", existing: 0, newDocs: 1 },
    ]);
    expect(fromCalls).toContain("lottery_doc_stats");
    expect(fromCalls).toContain("assignments");
  });
});
