import { describe, it, expect } from "vitest";
import { findNextPendingDocIndex } from "@/lib/compare-queue-navigation";

describe("findNextPendingDocIndex", () => {
  const divergentFields = { d1: ["a"], d2: ["a"], d3: ["a"] };

  it("returns the first pending doc, skipping the current one", () => {
    const reviews = {};
    expect(
      findNextPendingDocIndex(["d1", "d2", "d3"], divergentFields, reviews, "d1"),
    ).toBe(1);
  });

  it("finds a pending doc at the top after the queue was re-sorted", () => {
    // Server re-sorts completed docs to the bottom: the just-finished doc (d1)
    // is now last, pending docs are at the top. `currentIndex + 1` would point
    // past the end — the helper must still find d2 at index 0.
    const reviews = { d1: { a: {} } };
    expect(
      findNextPendingDocIndex(["d2", "d3", "d1"], divergentFields, reviews, "d1"),
    ).toBe(0);
  });

  it("skips docs that are already complete", () => {
    const reviews = { d1: { a: {} }, d2: { a: {} } };
    expect(
      findNextPendingDocIndex(["d2", "d3", "d1"], divergentFields, reviews, "d1"),
    ).toBe(1);
  });

  it("returns -1 when every other doc is complete", () => {
    const reviews = { d1: { a: {} }, d2: { a: {} }, d3: { a: {} } };
    expect(
      findNextPendingDocIndex(["d2", "d3", "d1"], divergentFields, reviews, "d1"),
    ).toBe(-1);
  });
});
