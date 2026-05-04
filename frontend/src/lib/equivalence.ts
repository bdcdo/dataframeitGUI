export interface EquivalencePair {
  response_a_id: string;
  response_b_id: string;
}

// Computes equivalence classes via union-find. The class key is the
// lexicographically smallest response id in the class — stable and
// deterministic so divergence detection can use it as a grouping key.
export function buildEquivalenceClasses(
  responseIds: string[],
  pairs: EquivalencePair[],
): Map<string, string> {
  const parent = new Map<string, string>();
  for (const id of responseIds) parent.set(id, id);

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
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the smaller id as the root for stable class keys.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  }

  for (const p of pairs) union(p.response_a_id, p.response_b_id);

  const result = new Map<string, string>();
  for (const id of responseIds) result.set(id, find(id));
  return result;
}

export function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
