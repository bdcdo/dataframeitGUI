import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseMock, type RpcCall } from "./supabase-mock";

let rpcCalls: RpcCall[];
let rpcResults: Record<string, { data?: unknown; error?: { message: string } | null }>;

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
vi.mock("@/lib/compare-sync", () => ({ finalizeCompareWrite: async () => {} }));

beforeEach(() => {
  rpcCalls = [];
  rpcResults = {};
});

describe("submitVerdict", () => {
  it("envia apenas IDs e deixa snapshot/comentário de ambiguidade na RPC", async () => {
    const { submitVerdict } = await import("@/actions/reviews");
    expect(
      await submitVerdict(
        "p1",
        "d1",
        "q1",
        "ambiguo",
        undefined,
        "  depende do contexto  ",
        ["r1", "r2"],
      ),
    ).toEqual({});
    expect(rpcCalls).toContainEqual({
      fn: "submit_compare_review",
      args: {
        p_project_id: "p1",
        p_document_id: "d1",
        p_field_name: "q1",
        p_reviewer_id: "member1",
        p_verdict: "ambiguo",
        p_chosen_response_id: null,
        p_comment: "depende do contexto",
        p_comparison_response_ids: ["r1", "r2"],
        p_equivalent_response_ids: null,
      },
    });
  });

  it("retorna o erro da RPC sem lançar", async () => {
    rpcResults.submit_compare_review = { error: { message: "snapshot inválido" } };
    const { submitVerdict } = await import("@/actions/reviews");
    expect(await submitVerdict("p1", "d1", "q1", "concordo")).toEqual({
      error: "snapshot inválido",
    });
  });
});
