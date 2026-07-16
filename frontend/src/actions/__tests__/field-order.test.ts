import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectIdentityActionHarness } from "./project-identity-harness";

const resolveMemberUserId = vi.hoisted(() =>
  vi.fn(async () => "canonical-member"),
);
const harness = createProjectIdentityActionHarness(resolveMemberUserId);

vi.mock("@/lib/auth", () => harness.authModule);
vi.mock("@/lib/supabase/server", () => harness.supabaseServerModule);

beforeEach(() => {
  harness.reset({
    researcher_field_orders: { data: { field_order: ["field_a"] } },
  });
  resolveMemberUserId.mockReset();
  resolveMemberUserId.mockResolvedValue("canonical-member");
});

describe("researcher field order — identidade canônica", () => {
  it("lê a preferência do membro canônico da conta-alias", async () => {
    const { getResearcherFieldOrder } = await import("@/actions/field-order");

    const result = await getResearcherFieldOrder("project-1");

    expect(result).toEqual({ order: ["field_a"] });
    expect(resolveMemberUserId).toHaveBeenCalledWith("project-1");
  });

  it("grava a preferência em nome do membro canônico", async () => {
    harness.supabase.tableResults!.researcher_field_orders = { error: null };
    const { saveResearcherFieldOrder } = await import("@/actions/field-order");

    const result = await saveResearcherFieldOrder("project-1", ["field_b"]);

    expect(result).toEqual({ success: true });
    expect(harness.supabase.writeCalls).toContainEqual({
      table: "researcher_field_orders",
      op: "upsert",
      payload: {
        project_id: "project-1",
        user_id: "canonical-member",
        field_order: ["field_b"],
        updated_at: expect.any(String),
      },
    });
  });

  it("não lê nem grava quando a identidade canônica está indisponível", async () => {
    resolveMemberUserId.mockRejectedValueOnce(
      new Error("identity unavailable"),
    );
    const { saveResearcherFieldOrder } = await import("@/actions/field-order");

    const result = await saveResearcherFieldOrder("project-1", ["field_b"]);

    expect(result).toEqual({
      success: false,
      error: "Não foi possível verificar sua identidade no projeto.",
    });
    expect(harness.supabase.writeCalls).toEqual([]);
  });
});
