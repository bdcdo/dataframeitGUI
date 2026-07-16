import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeSupabaseMock,
  type FilterCall,
  type RpcCall,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

const state = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  effectiveUserId: "member-1",
  isCoordinator: true,
  revalidateDocuments: vi.fn(async (projectId: string) => {
    void projectId;
  }),
}));
let rpcCalls: RpcCall[];
let rpcResults: Record<string, { data?: unknown; error?: { message: string } | null }>;
let tableResults: TableResults;
let writeCalls: WriteCall[];
let filterCalls: FilterCall[];

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => state.user,
  getEffectiveMemberId: async () => state.effectiveUserId,
  resolveProjectActor: async () =>
    state.user
      ? { ok: true, user: state.user, effectiveUserId: state.effectiveUserId }
      : { ok: false, error: "Não autenticado" },
  requireCoordinator: async (_projectId: string, deniedMessage: string) => {
    if (!state.user) return { ok: false, error: "Não autenticado" };
    return state.isCoordinator
      ? { ok: true, user: state.user, effectiveUserId: state.effectiveUserId }
      : { ok: false, error: deniedMessage };
  },
}));
vi.mock("@/actions/documents", () => ({
  revalidateProjectDocumentsCache: (...args: unknown[]) =>
    state.revalidateDocuments(...(args as [string])),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({
      tableResults,
      writeCalls,
      filterCalls,
      rpcCalls,
      rpcResults,
    }),
}));

beforeEach(() => {
  state.user = { id: "user-1" };
  state.effectiveUserId = "member-1";
  state.isCoordinator = true;
  state.revalidateDocuments.mockClear();
  rpcCalls = [];
  rpcResults = {};
  tableResults = {};
  writeCalls = [];
  filterCalls = [];
});

async function actions() {
  return import("@/actions/project-comments");
}

describe("requestDocumentExclusion", () => {
  it("recusa motivo vazio sem chamar o banco", async () => {
    const { requestDocumentExclusion } = await actions();
    expect(await requestDocumentExclusion("p1", "d1", "  ")).toEqual({
      error: "Informe o motivo da sugestão de exclusão",
    });
    expect(rpcCalls).toEqual([]);
  });

  it("delega validação e criação à RPC atômica", async () => {
    const { requestDocumentExclusion } = await actions();
    expect(await requestDocumentExclusion("p1", "d1", "  fora do tema  ")).toEqual({
      success: true,
    });
    expect(rpcCalls).toContainEqual({
      fn: "request_document_exclusion",
      args: {
        p_project_id: "p1",
        p_document_id: "d1",
        p_reason: "fora do tema",
      },
    });
    expect(writeCalls).toEqual([]);
    expect(state.revalidateDocuments).toHaveBeenCalledWith("p1");
  });

  it("propaga erro de contrato do banco", async () => {
    rpcResults.request_document_exclusion = {
      error: { message: "Documento já está em revisão de escopo" },
    };
    const { requestDocumentExclusion } = await actions();
    const result = await requestDocumentExclusion("p1", "d1", "fora");
    expect(result.error).toContain("já está em revisão");
  });
});

describe("cancelExclusionRequest", () => {
  it("mantém DELETE estreito do pedido pendente do próprio autor", async () => {
    tableResults.project_comments = { data: [{ id: "c1" }] };
    const { cancelExclusionRequest } = await actions();
    expect(await cancelExclusionRequest("p1", "d1")).toEqual({ success: true });
    expect(writeCalls).toContainEqual({
      table: "project_comments",
      op: "delete",
      payload: null,
    });
  });
});

describe("decisão de exclusão", () => {
  it("barra não-coordenador antes da RPC", async () => {
    state.isCoordinator = false;
    const { approveExclusionRequest } = await actions();
    const result = await approveExclusionRequest("c1", "p1");
    expect(result.error).toContain("coordenador");
    expect(rpcCalls).toEqual([]);
  });

  it("aprova por decide_exclusion_request", async () => {
    const { approveExclusionRequest } = await actions();
    expect(await approveExclusionRequest("c1", "p1")).toEqual({ success: true });
    expect(rpcCalls).toContainEqual({
      fn: "decide_exclusion_request",
      args: {
        p_project_id: "p1",
        p_comment_id: "c1",
        p_decision: "approve",
        p_reason: null,
      },
    });
  });

  it("rejeita por decide_exclusion_request com motivo trimado", async () => {
    const { rejectExclusionRequest } = await actions();
    expect(await rejectExclusionRequest("c1", "p1", "  está no escopo  ")).toEqual({
      success: true,
    });
    expect(rpcCalls).toContainEqual({
      fn: "decide_exclusion_request",
      args: {
        p_project_id: "p1",
        p_comment_id: "c1",
        p_decision: "reject",
        p_reason: "está no escopo",
      },
    });
  });
});

describe("comentários genéricos", () => {
  it.each([
    ["resolve", "resolveProjectComment"],
    ["reopen", "reopenProjectComment"],
  ])("%s não alcança exclusion_request", async (_label, actionName) => {
    tableResults.project_comments = { data: [{ id: "c1" }] };
    const actionsModule = await actions();
    const action = actionsModule[actionName as keyof typeof actionsModule] as (
      commentId: string,
      projectId: string,
    ) => Promise<{ success?: boolean; error?: string }>;

    expect(await action("c1", "p1")).toEqual({ success: true });
    expect(filterCalls).toContainEqual({
      table: "project_comments",
      method: "neq",
      column: "kind",
      value: "exclusion_request",
    });
    if (_label === "resolve") {
      expect(writeCalls).toContainEqual({
        table: "project_comments",
        op: "update",
        payload: expect.objectContaining({ resolved_by: "member-1" }),
      });
    }
  });
});
