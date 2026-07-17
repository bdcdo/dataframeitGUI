import "server-only";

import { timingSafeEqual } from "node:crypto";

export function isAutoReviewReconciliationBearer(
  authorization: string | null,
): boolean {
  const secret = process.env.AUTO_REVIEW_RECONCILIATION_SECRET;
  if (!secret || !authorization?.startsWith("Bearer ")) return false;

  const expected = Buffer.from(secret);
  const provided = Buffer.from(authorization.slice("Bearer ".length));
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
