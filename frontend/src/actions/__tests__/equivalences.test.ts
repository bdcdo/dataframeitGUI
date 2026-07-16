import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseMock, type RpcCall } from "./supabase-mock";

let rpcCalls: RpcCall[];
let rpcResults: Record<string, { data?: unknown; error?: { message: string } | null }>;
let syncError: Error | undefined;

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "account1" }),
  getEffectiveMemberId: async () => "member1",
  resolveProjectActor: async () => ({
    ok: true,
    user: { id: "account1" },
    effectiveUserId: "member1",
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeSupabaseMock({ rpcCalls, rpcResults }),
}));
vi.mock("@/lib/compare-sync", () => ({
  finalizeCompareWrite: () => {
    if (syncError) console.error(`[test] ${syncError.message}`);
  },
  scheduleCompareRevalidation: () => {},
}));

beforeEach(() => {
  rpcCalls = [];
  rpcResults = {};
  syncError = undefined;
});

describe("confirmEquivalentVerdict", () => {
  it("grava equivalências, review e snapshot em uma transação", async () => {
    const { confirmEquivalentVerdict } = await import("@/actions/equivalences");
    expect(
      await confirmEquivalentVerdict(
        "p1",
        "d1",
        "q1",
        ["r2", "r1"],
        "r2",
        "resposta fundida",
        "  nota  ",
        ["r1", "r2", "r3"],
      ),
    ).toEqual({});
    expect(rpcCalls).toContainEqual({
      fn: "submit_compare_review",
      args: {
        p_project_id: "p1",
        p_document_id: "d1",
        p_field_name: "q1",
        p_reviewer_id: "member1",
        p_verdict: "resposta fundida",
        p_chosen_response_id: "r2",
        p_comment: "nota",
        p_comparison_response_ids: ["r1", "r2", "r3"],
        p_equivalent_response_ids: ["r2", "r1"],
      },
    });
  });

  it("valida o grupo antes da RPC", async () => {
    const { confirmEquivalentVerdict } = await import("@/actions/equivalences");
    expect(
      await confirmEquivalentVerdict("p1", "d1", "q1", ["r1"], "r1", "x"),
    ).toEqual({ error: "Marcar como equivalentes exige 2+ respostas." });
    expect(rpcCalls).toEqual([]);
  });
});

describe("markLlmEquivalent", () => {
  it("usa a RPC estreita com par canônico", async () => {
    const { markLlmEquivalent } = await import("@/actions/equivalences");
    expect(await markLlmEquivalent("p1", "d1", "q1", "z", "a")).toEqual({});
    expect(rpcCalls).toContainEqual({
      fn: "add_response_equivalence",
      args: {
        p_project_id: "p1",
        p_document_id: "d1",
        p_field_name: "q1",
        p_response_a_id: "a",
        p_response_b_id: "z",
        p_reviewer_id: "member1",
      },
    });
  });
});

describe("unmarkEquivalencePair", () => {
  it("remove equivalência e review associado na mesma RPC", async () => {
    rpcResults.remove_response_equivalence = {
      data: { documentId: "d1", fieldName: "q1", removedCount: 1 },
    };
    const { unmarkEquivalencePair } = await import("@/actions/equivalences");
    expect(await unmarkEquivalencePair("p1", "eq1")).toEqual({});
    expect(rpcCalls).toContainEqual({
      fn: "remove_response_equivalence",
      args: {
        p_project_id: "p1",
        p_equivalence_id: "eq1",
        p_reviewer_id: "member1",
      },
    });
  });

  it("retorna erro da RPC sem lançar", async () => {
    rpcResults.remove_response_equivalence = { error: { message: "sem permissão" } };
    const { unmarkEquivalencePair } = await import("@/actions/equivalences");
    expect(await unmarkEquivalencePair("p1", "eq1")).toEqual({
      error: "sem permissão",
    });
  });

  it("não reporta falha de gravação quando só o sync pós-commit falha", async () => {
    rpcResults.remove_response_equivalence = {
      data: { documentId: "d1", fieldName: "q1", removedCount: 1 },
    };
    syncError = new Error("sync indisponível");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmarkEquivalencePair } = await import("@/actions/equivalences");
    expect(await unmarkEquivalencePair("p1", "eq1")).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("sync indisponível"),
    );
    errorSpy.mockRestore();
  });
});
