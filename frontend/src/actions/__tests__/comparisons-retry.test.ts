import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  callsOf,
  makeFilterAwareSupabaseMock,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { authModuleMock } from "@/test-utils/auth-mock";
import {
  makeHumanResponse,
  makeProjectMember,
  makeProjectRow,
} from "@/test-utils/comparison-fixtures";

// Mock supabase filter-aware (mesmo padrão de lib/__tests__/auto-comparison.test.ts).
let writeCalls: WriteCall[];
let tableData: Record<string, unknown[]>;

const upsertCallsOf = (table?: string) => callsOf(writeCalls, "upsert", table);

function makeClient() {
  return makeFilterAwareSupabaseMock({ tableData, writeCalls });
}

const hoisted = vi.hoisted(() => ({
  isCoord: vi.fn<() => Promise<boolean>>(async () => true),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => authModuleMock(hoisted.isCoord));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeClient(),
}));

beforeEach(() => {
  writeCalls = [];
  tableData = {
    projects: [makeProjectRow()],
    project_members: [],
    assignments: [],
    responses: [],
    response_equivalences: [],
    // Docs ativos e fora de revisão de escopo — o gatilho consulta `documents`.
    documents: [
      { id: "doc1", project_id: "p1", excluded_at: null, exclusion_pending_at: null },
      { id: "doc2", project_id: "p1", excluded_at: null, exclusion_pending_at: null },
    ],
  };
  hoisted.isCoord.mockResolvedValue(true);
});

async function loadRetry() {
  return (await import("@/actions/comparisons")).retryPendingComparisons;
}

describe("retryPendingComparisons — guards", () => {
  it("não-coordenador → erro, sem efeito", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(false);
    expect(r.error).toContain("coordenadores");
    expect(writeCalls).toHaveLength(0);
  });

  it("modo não-comparação → no-op", async () => {
    tableData.projects = [makeProjectRow({ automation_mode: "auto_review_llm" })];
    tableData.responses = [makeHumanResponse("userA", "A"), makeHumanResponse("userB", "B")];
    tableData.project_members = [makeProjectMember("userC")];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(upsertCallsOf("assignments")).toHaveLength(0);
  });
});

describe("retryPendingComparisons — atribui backlog divergente", () => {
  it("doc divergente sem comparacao ativa → atribui 1", async () => {
    tableData.responses = [makeHumanResponse("userA", "A"), makeHumanResponse("userB", "B")];
    tableData.project_members = [makeProjectMember("userC")];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(1);
    expect(r.stillNoPool).toBe(0);
    expect(upsertCallsOf("assignments")[0].payload).toMatchObject({
      document_id: "doc1",
      user_id: "userC",
      type: "comparacao",
    });
  });

  it("doc divergente sem revisor elegível → stillNoPool", async () => {
    tableData.responses = [makeHumanResponse("userA", "A"), makeHumanResponse("userB", "B")];
    tableData.project_members = []; // ninguém can_compare
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(1);
  });

  it("doc em consenso → nada a atribuir", async () => {
    tableData.responses = [makeHumanResponse("userA", "A"), makeHumanResponse("userB", "A")];
    tableData.project_members = [makeProjectMember("userC")];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
  });
});
