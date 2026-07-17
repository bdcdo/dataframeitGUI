import { describe, it, expect } from "vitest";
import {
  buildResponseGroupKeys,
  canonicalPair,
  filterCurrentEquivalencePairs,
  type EquivalenceEdge,
} from "@/lib/equivalence";

interface Resp {
  id: string;
  answer: string;
}

function classes(map: Map<string, string>): string[][] {
  const buckets = new Map<string, string[]>();
  for (const [id, key] of map) {
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(id);
  }
  return [...buckets.values()].map((arr) => arr.sort()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
}

describe("canonicalPair", () => {
  it("orders ids lexicographically (a < b)", () => {
    expect(canonicalPair("b", "a")).toEqual(["a", "b"]);
    expect(canonicalPair("a", "b")).toEqual(["a", "b"]);
  });

  it("preserves equal ids (degenerate, but doesn't crash)", () => {
    expect(canonicalPair("a", "a")).toEqual(["a", "a"]);
  });
});

describe("buildResponseGroupKeys", () => {
  const getAnswer = (r: Resp) => r.answer;

  it("with no pairs and unique answers, every response is its own class", () => {
    const responses: Resp[] = [
      { id: "a", answer: "x" },
      { id: "b", answer: "y" },
      { id: "c", answer: "z" },
    ];
    const result = buildResponseGroupKeys(responses, [], getAnswer);
    expect(classes(result)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("fuses responses with the same normalized answer (no pairs)", () => {
    const responses: Resp[] = [
      { id: "a", answer: "foo" },
      { id: "b", answer: "foo" },
      { id: "c", answer: "bar" },
    ];
    const result = buildResponseGroupKeys(responses, [], getAnswer);
    expect(classes(result)).toEqual([["a", "b"], ["c"]]);
  });

  it("regression: pair A↔C plus B with same answer as A → all in same class", () => {
    // The fix from PR #75 second commit: a paired-response and an unpaired
    // response sharing the same literal answer must end up in the same group.
    const responses: Resp[] = [
      { id: "a", answer: "foo" },
      { id: "b", answer: "foo" },
      { id: "c", answer: "bar" },
    ];
    const pairs: EquivalenceEdge[] = [
      { response_a_id: "a", response_b_id: "c" },
    ];
    const result = buildResponseGroupKeys(responses, pairs, getAnswer);
    expect(classes(result)).toEqual([["a", "b", "c"]]);
  });

  it("ignores pair edges whose endpoints aren't in the response set", () => {
    const responses: Resp[] = [
      { id: "a", answer: "x" },
      { id: "b", answer: "y" },
    ];
    const pairs: EquivalenceEdge[] = [
      { response_a_id: "a", response_b_id: "ghost" },
    ];
    const result = buildResponseGroupKeys(responses, pairs, getAnswer);
    expect(classes(result)).toEqual([["a"], ["b"]]);
  });

  it("transitive closure: A↔B and B↔C produces {A,B,C}", () => {
    const responses: Resp[] = [
      { id: "a", answer: "1" },
      { id: "b", answer: "2" },
      { id: "c", answer: "3" },
    ];
    const pairs: EquivalenceEdge[] = [
      { response_a_id: "a", response_b_id: "b" },
      { response_a_id: "b", response_b_id: "c" },
    ];
    const result = buildResponseGroupKeys(responses, pairs, getAnswer);
    expect(classes(result)).toEqual([["a", "b", "c"]]);
  });

  it("class key is the lex-smallest id (stable/deterministic)", () => {
    const responses: Resp[] = [
      { id: "z", answer: "x" },
      { id: "a", answer: "y" },
      { id: "m", answer: "z" },
    ];
    const pairs: EquivalenceEdge[] = [
      { response_a_id: "z", response_b_id: "a" },
      { response_a_id: "a", response_b_id: "m" },
    ];
    const result = buildResponseGroupKeys(responses, pairs, getAnswer);
    expect(result.get("z")).toBe("a");
    expect(result.get("a")).toBe("a");
    expect(result.get("m")).toBe("a");
  });

  it("disjoint pairs don't bleed into each other", () => {
    const responses: Resp[] = [
      { id: "a", answer: "1" },
      { id: "b", answer: "2" },
      { id: "c", answer: "3" },
      { id: "d", answer: "4" },
    ];
    const pairs: EquivalenceEdge[] = [
      { response_a_id: "a", response_b_id: "b" },
      { response_a_id: "c", response_b_id: "d" },
    ];
    const result = buildResponseGroupKeys(responses, pairs, getAnswer);
    expect(classes(result)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("filterCurrentEquivalencePairs", () => {
  const responses: Resp[] = [
    { id: "a", answer: "current-a" },
    { id: "b", answer: "current-b" },
  ];

  it("mantém a decisão enquanto os dois valores correspondem aos snapshots", () => {
    const pairs = [{
      response_a_id: "a",
      response_b_id: "b",
      response_a_answer_snapshot: "current-a",
      response_b_answer_snapshot: "current-b",
    }];
    expect(
      filterCurrentEquivalencePairs(responses, pairs, (response) => response.answer),
    ).toEqual(pairs);
  });

  it("descarta a decisão assim que um endpoint muda", () => {
    const pairs = [{
      response_a_id: "a",
      response_b_id: "b",
      response_a_answer_snapshot: "old-a",
      response_b_answer_snapshot: "current-b",
    }];
    expect(
      filterCurrentEquivalencePairs(responses, pairs, (response) => response.answer),
    ).toEqual([]);
  });

  it("descarta decisão sem snapshots verificáveis", () => {
    const pairs = [
      { response_a_id: "a", response_b_id: "b" },
    ] as unknown as Parameters<typeof filterCurrentEquivalencePairs>[1];
    expect(
      filterCurrentEquivalencePairs(responses, pairs, (response) => response.answer),
    ).toEqual([]);
  });

  it("usa a mesma normalização da comparação de respostas", () => {
    const pairs = [{
      response_a_id: "a",
      response_b_id: "b",
      response_a_answer_snapshot: "  CURRENT-A  ",
      response_b_answer_snapshot: "current-b",
    }];
    expect(
      filterCurrentEquivalencePairs(responses, pairs, (response) => response.answer),
    ).toEqual(pairs);
  });
});
