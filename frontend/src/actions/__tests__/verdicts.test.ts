import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";

const { upsert, getEffectiveMemberId } = vi.hoisted(() => ({
  upsert: vi.fn(async () => ({ error: null })),
  getEffectiveMemberId: vi.fn(async (projectId: string) => {
    void projectId;
    return "canonical-member";
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(async () => ({ id: "linked-account" })),
  getEffectiveMemberId,
  resolveProjectActor: async (projectId: string) => ({
    ok: true,
    user: { id: "linked-account" },
    effectiveUserId: await getEffectiveMemberId(projectId),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: vi.fn(async () => ({
    from: vi.fn(() => ({ upsert })),
  })),
}));

import { acknowledgeVerdict } from "@/actions/verdicts";

describe("acknowledgeVerdict", () => {
  beforeEach(() => {
    upsert.mockClear();
    getEffectiveMemberId.mockClear();
    vi.mocked(revalidatePath).mockClear();
  });

  it("persiste a identidade canônica de uma conta vinculada", async () => {
    await expect(
      acknowledgeVerdict("review-1", "project-1", "accepted"),
    ).resolves.toEqual({});

    expect(getEffectiveMemberId).toHaveBeenCalledWith("project-1");
    expect(upsert).toHaveBeenCalledWith(
      {
        review_id: "review-1",
        respondent_id: "canonical-member",
        status: "accepted",
        comment: null,
      },
      { onConflict: "review_id,respondent_id" },
    );
    expect(revalidatePath).toHaveBeenCalledWith(
      "/projects/project-1/reviews/my-verdicts",
    );
  });
});
