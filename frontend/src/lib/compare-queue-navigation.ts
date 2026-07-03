import { isDocComplete } from "@/lib/compare-assignment-status";

// Index of the next document that still has unreviewed divergences, scanning
// the queue in its current order and skipping `currentDocId`. Returns -1 when
// every other document is complete. The server re-sorts the queue on each
// revalidate (completed docs sink to the bottom), so "next parecer" must be
// found by completion state — never by `currentIndex + 1`.
export function findNextPendingDocIndex(
  docIds: string[],
  divergentFields: Record<string, string[]>,
  reviews: Record<string, Record<string, unknown>>,
  currentDocId: string | undefined,
): number {
  return docIds.findIndex(
    (id) =>
      id !== currentDocId && !isDocComplete(divergentFields[id], reviews[id]),
  );
}
