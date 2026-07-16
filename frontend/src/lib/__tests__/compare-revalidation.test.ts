import { beforeEach, describe, expect, it, vi } from "vitest";

const { revalidatePath, afterCallbacks } = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  afterCallbacks: [] as Array<() => void>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/server", () => ({
  after: (callback: () => void) => afterCallbacks.push(callback),
}));

import { scheduleCompareRevalidation } from "@/lib/compare-revalidation";

beforeEach(() => {
  afterCallbacks.length = 0;
  revalidatePath.mockClear();
});

describe("scheduleCompareRevalidation", () => {
  it("agenda somente invalidação de cache após a transação", () => {
    scheduleCompareRevalidation("p1", "submitVerdict", { comments: true });

    expect(revalidatePath).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    afterCallbacks[0]();
    expect(revalidatePath.mock.calls.map(([path]) => path)).toEqual([
      "/projects/p1/reviews/comments",
      "/projects/p1/analyze/compare",
      "/projects/p1/analyze/assignments",
    ]);
  });
});
