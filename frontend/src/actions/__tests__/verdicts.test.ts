import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectIdentityActionHarness } from "./project-identity-harness";
const resolveMemberUserId = vi.hoisted(() =>
  vi.fn(async () => "canonical-member"),
);
const harness = createProjectIdentityActionHarness(resolveMemberUserId);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => harness.authModule);
vi.mock("@/lib/supabase/server", () => harness.supabaseServerModule);

beforeEach(() => {
  harness.reset({ verdict_acknowledgments: { error: null } });
  resolveMemberUserId.mockReset();
  resolveMemberUserId.mockResolvedValue("canonical-member");
});

describe("acknowledgeVerdict", () => {
  it("grava o reconhecimento em nome do membro canônico", async () => {
    const { acknowledgeVerdict } = await import("@/actions/verdicts");

    const result = await acknowledgeVerdict(
      "review-1",
      "project-1",
      "accepted",
    );

    expect(result).toEqual({});
    expect(harness.supabase.writeCalls).toContainEqual({
      table: "verdict_acknowledgments",
      op: "upsert",
      payload: {
        review_id: "review-1",
        respondent_id: "canonical-member",
        status: "accepted",
        comment: null,
      },
    });
  });

  it("não grava quando a identidade canônica está indisponível", async () => {
    resolveMemberUserId.mockRejectedValueOnce(
      new Error("identity unavailable"),
    );
    const { acknowledgeVerdict } = await import("@/actions/verdicts");

    const result = await acknowledgeVerdict(
      "review-1",
      "project-1",
      "accepted",
    );

    expect(result).toEqual({
      error: "Não foi possível verificar sua identidade no projeto.",
    });
    expect(harness.supabase.writeCalls).toEqual([]);
  });
});
