import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeFilterAwareSupabaseMock,
  makeSupabaseAdminModuleMock,
  makeSupabaseServerModuleMock,
  type RpcCall,
  type RpcResult,
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
let rpcCalls: RpcCall[];
let rpcResults: Record<string, RpcResult>;
let tableData: Record<string, unknown[]>;
let adminCreateCalls: number;

const assignmentCalls = () =>
  rpcCalls.filter((call) => call.fn === "assign_comparison_if_eligible");

function makeClient() {
  return makeFilterAwareSupabaseMock({
    tableData,
    writeCalls,
    rpcCalls,
    rpcResults,
  });
}

const hoisted = vi.hoisted(() => ({
  isCoord: vi.fn<() => Promise<boolean>>(async () => true),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => authModuleMock(hoisted.isCoord));
vi.mock("@/lib/supabase/server", () => makeSupabaseServerModuleMock(makeClient));
vi.mock("@/lib/supabase/admin", () =>
  makeSupabaseAdminModuleMock(makeClient, () => adminCreateCalls++),
);

beforeEach(() => {
  writeCalls = [];
  adminCreateCalls = 0;
  rpcCalls = [];
  rpcResults = {
    assign_comparison_if_eligible: { data: true },
  };
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
    expect(adminCreateCalls).toBe(0);
  });

  it("modo não-comparação → no-op", async () => {
    tableData.projects = [makeProjectRow({ automation_mode: "auto_review_llm" })];
    tableData.responses = [makeHumanResponse("userA", "A"), makeHumanResponse("userB", "B")];
    tableData.project_members = [makeProjectMember("userC")];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(assignmentCalls()).toHaveLength(0);
    expect(adminCreateCalls).toBe(0);
  });

  it("falha ao ler o modo do projeto não vira no-op bem-sucedido", async () => {
    tableData["__error:projects:select"] = {
      message: "timeout projeto",
    } as unknown as unknown[];
    const retry = await loadRetry();

    await expect(retry("p1")).resolves.toEqual({
      success: false,
      error: "timeout projeto",
      assigned: 0,
      stillNoPool: 0,
    });
    expect(adminCreateCalls).toBe(0);
  });

  it("backlog vazio não cria cliente administrativo", async () => {
    const retry = await loadRetry();
    await expect(retry("p1")).resolves.toEqual({
      success: true,
      assigned: 0,
      stillNoPool: 0,
    });
    expect(adminCreateCalls).toBe(0);
  });
});

describe("retryPendingComparisons — atribui backlog divergente", () => {
  it("falha ao ler a carga aberta não atribui com carga inventada", async () => {
    tableData.responses = [makeHumanResponse("userA", "A"), makeHumanResponse("userB", "B")];
    tableData.project_members = [makeProjectMember("userC")];
    tableData["__error:assignments:select"] = {
      message: "timeout carga",
    } as unknown as unknown[];
    const retry = await loadRetry();

    await expect(retry("p1")).resolves.toEqual({
      success: false,
      error: "timeout carga",
      assigned: 0,
      stillNoPool: 0,
    });
    expect(assignmentCalls()).toHaveLength(0);
    expect(adminCreateCalls).toBe(0);
  });

  it("doc divergente sem comparacao ativa → atribui 1", async () => {
    tableData.responses = [makeHumanResponse("userA", "A"), makeHumanResponse("userB", "B")];
    tableData.project_members = [makeProjectMember("userC")];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(1);
    expect(r.stillNoPool).toBe(0);
    expect(adminCreateCalls).toBe(1);
    expect(assignmentCalls()[0].args).toEqual({
      p_project_id: "p1",
      p_document_id: "doc1",
      p_user_id: "userC",
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
