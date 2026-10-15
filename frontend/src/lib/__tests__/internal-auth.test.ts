import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const originalSecret = process.env.AUTO_REVIEW_RECONCILIATION_SECRET;

beforeEach(() => {
  process.env.AUTO_REVIEW_RECONCILIATION_SECRET = "dedicated-secret";
});

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.AUTO_REVIEW_RECONCILIATION_SECRET;
  } else {
    process.env.AUTO_REVIEW_RECONCILIATION_SECRET = originalSecret;
  }
});

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/lib/internal-auth");
}, 30_000);

describe("isAutoReviewReconciliationBearer", () => {
  it("aceita somente o segredo interno dedicado", async () => {
    const { isAutoReviewReconciliationBearer } = await import("@/lib/internal-auth");

    expect(isAutoReviewReconciliationBearer("Bearer dedicated-secret")).toBe(true);
    expect(isAutoReviewReconciliationBearer("Bearer service-role-key")).toBe(false);
    expect(isAutoReviewReconciliationBearer(null)).toBe(false);
  });

  it("falha fechado quando o segredo não está configurado", async () => {
    delete process.env.AUTO_REVIEW_RECONCILIATION_SECRET;
    const { isAutoReviewReconciliationBearer } = await import("@/lib/internal-auth");

    expect(isAutoReviewReconciliationBearer("Bearer dedicated-secret")).toBe(false);
  });
});
