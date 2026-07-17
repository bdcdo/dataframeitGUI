import { normalizeForComparison } from "@/lib/utils";

export interface EquivalenceEdge {
  response_a_id: string;
  response_b_id: string;
}

export interface EquivalencePair extends EquivalenceEdge {
  response_a_answer_snapshot: unknown;
  response_b_answer_snapshot: unknown;
}

// An equivalence is a decision about two answer values, not permanently about
// two mutable response rows. Missing snapshots fail closed: a caller that
// forgets to select them cannot silently reactivate an unverifiable decision.
export function filterCurrentEquivalencePairs<
  T extends { id: string },
  P extends EquivalencePair,
>(
  responses: T[],
  pairs: P[],
  getAnswer: (response: T) => unknown,
): P[] {
  const byId = new Map(responses.map((response) => [response.id, response]));

  return pairs.filter((pair) => {
    const responseA = byId.get(pair.response_a_id);
    const responseB = byId.get(pair.response_b_id);
    if (!responseA || !responseB) return false;

    if (
      pair.response_a_answer_snapshot === undefined ||
      pair.response_b_answer_snapshot === undefined
    ) return false;

    return (
      normalizeForComparison(pair.response_a_answer_snapshot) ===
        normalizeForComparison(getAnswer(responseA)) &&
      normalizeForComparison(pair.response_b_answer_snapshot) ===
        normalizeForComparison(getAnswer(responseB))
    );
  });
}

// Unified grouping key via union-find: fuses responses connected via
// explicit pairs OR sharing the same normalized answer. Two responses
// end up in the same group iff they're reachable via a chain of
// pair-edges and same-answer edges. Returns id -> classKey (lex-smallest
// id in the class — stable and deterministic).
//
// Same-answer fusion is required so unpaired responses with the same
// literal text as a paired response don't end up in a separate group.
export function buildResponseGroupKeys<T extends { id: string }>(
  responses: T[],
  pairs: EquivalenceEdge[],
  getAnswerKey: (r: T) => string,
): Map<string, string> {
  const parent = new Map<string, string>();
  for (const r of responses) parent.set(r.id, r.id);

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: string, b: string) {
    // Pairs whose endpoints aren't in the current response set are silently
    // ignored (e.g. response deleted between page load and grouping call).
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the lex-smaller id as the root for stable class keys.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  }

  for (const p of pairs) union(p.response_a_id, p.response_b_id);

  // Second pass: union responses sharing the same normalized answer.
  const firstByAnswer = new Map<string, string>();
  for (const r of responses) {
    const key = getAnswerKey(r);
    const seen = firstByAnswer.get(key);
    if (seen === undefined) firstByAnswer.set(key, r.id);
    else union(seen, r.id);
  }

  const result = new Map<string, string>();
  for (const r of responses) result.set(r.id, find(r.id));
  return result;
}

export function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
