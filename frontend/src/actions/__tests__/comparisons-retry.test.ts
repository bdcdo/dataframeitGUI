import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeFilterAwareSupabaseMock,
  type RpcCall,
  type RpcResult,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { authModuleMock } from "@/test-utils/auth-mock";
import {
  makeHumanResponse,
  makeEmptyComparisonTableData,
  makeIncompleteCoderComparisonScenario,
  makeProjectMember,
  makeProjectRow,
} from "@/test-utils/comparison-fixtures";

// Mock supabase filter-aware (mesmo padrão de lib/__tests__/auto-comparison.test.ts).
let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let rpcResults: Record<string, RpcResult>;
let tableData: Record<string, unknown[]>;
let assignmentSelectErrorAt: number | null;

const assignmentCalls = () =>
  rpcCalls.filter((call) => call.fn === "assign_comparison_if_eligible");

function makeClient() {
  const client = makeFilterAwareSupabaseMock({
    tableData,
    writeCalls,
    rpcCalls,
    rpcResults,
  });
  let assignmentSelectCount = 0;
  return {
    ...client,
    from: (table: string) => {
      const builder = client.from(table) as Record<string, unknown>;
      if (table !== "assignments") return builder;

      const originalThen = builder.then as (
        resolve: (value: unknown) => unknown,
      ) => unknown;
      builder.then = (resolve: (value: unknown) => unknown) => {
        assignmentSelectCount++;
        if (assignmentSelectCount === assignmentSelectErrorAt) {
          return resolve({
            data: null,
            error: { message: "falha ao carregar carga aberta" },
          });
        }
        return originalThen(resolve);
      };
      return builder;
    },
  };
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
  rpcCalls = [];
  rpcResults = {
    assign_comparison_if_eligible: { data: true },
  };
  tableData = makeEmptyComparisonTableData(["doc1", "doc2"]);
  assignmentSelectErrorAt = null;
  hoisted.isCoord.mockResolvedValue(true);
});

async function loadRetry() {
  return (await import("@/actions/comparisons")).retryPendingComparisons;
}

async function runRetry() {
  return (await loadRetry())("p1");
}

function setHumanResponses(first: string, second: string) {
  tableData.responses = [
    makeHumanResponse("userA", first),
    makeHumanResponse("userB", second),
  ];
}

async function runRetryWithEligibleReviewer(first: string, second: string) {
  setHumanResponses(first, second);
  tableData.project_members = [makeProjectMember("userC")];
  return runRetry();
}

describe("retryPendingComparisons — guards", () => {
  it("não-coordenador → erro, sem efeito", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r).toEqual({
      success: false,
      error: "Apenas coordenadores podem reprocessar comparações.",
      assigned: 0,
      stillNoPool: 0,
    });
    expect(writeCalls).toEqual([]);
  });

  it("modo não-comparação → no-op", async () => {
    tableData.projects = [
      makeProjectRow({ automation_mode: "auto_review_llm" }),
    ];
    const r = await runRetryWithEligibleReviewer("A", "B");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(assignmentCalls()).toHaveLength(0);
  });

  it("falha ao carregar projeto → erro técnico, sem RPC", async () => {
    tableData["__error:projects:select"] = {
      message: "falha ao carregar projeto",
    } as unknown as unknown[];

    const result = await runRetry();

    expect(result).toMatchObject({
      success: false,
      error: "falha ao carregar projeto",
      assigned: 0,
      stillNoPool: 0,
    });
    expect(assignmentCalls()).toHaveLength(0);
  });

  it("falha ao carregar carga aberta → erro técnico, sem RPC", async () => {
    setHumanResponses("A", "B");
    tableData.project_members = [makeProjectMember("userC")];
    // A primeira leitura de assignments pertence ao scan do backlog; a segunda
    // carrega a distribuição usada antes de escolher qualquer revisor.
    assignmentSelectErrorAt = 2;

    const result = await runRetry();

    expect(result).toMatchObject({
      success: false,
      error: "falha ao carregar carga aberta",
      assigned: 0,
      stillNoPool: 0,
    });
    expect(assignmentCalls()).toHaveLength(0);
  });
});

describe("retryPendingComparisons — atribui backlog divergente", () => {
  it("doc divergente sem comparacao ativa → atribui 1", async () => {
    const r = await runRetryWithEligibleReviewer("A", "B");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(1);
    expect(r.stillNoPool).toBe(0);
    expect(assignmentCalls()[0].args).toEqual({
      p_project_id: "p1",
      p_document_id: "doc1",
      p_user_id: "userC",
    });
  });

  it("retry exclui do pool quem tem resposta vigente incompleta", async () => {
    const scenario = makeIncompleteCoderComparisonScenario();
    tableData.responses = scenario.responses;
    tableData.project_members = scenario.members;
    // Se o backlog derivasse coderIds apenas das respostas completas, userC
    // teria carga zero e venceria userD, que já possui uma comparação aberta.
    tableData.assignments = scenario.openAssignments;

    const result = await runRetry();

    expect(result.success).toBe(true);
    expect(result.assigned).toBe(1);
    expect(assignmentCalls()[0].args).toEqual({
      p_project_id: "p1",
      p_document_id: "doc1",
      p_user_id: "userD",
    });
  });

  it("doc divergente sem revisor elegível → stillNoPool", async () => {
    setHumanResponses("A", "B");
    tableData.project_members = []; // ninguém can_compare
    const r = await runRetry();
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(1);
  });

  it("doc em consenso → nada a atribuir", async () => {
    const r = await runRetryWithEligibleReviewer("A", "A");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
  });
});
