import { describe, it, expect } from "vitest";
import {
  affectedValueKeys,
  answerGroupKeys,
  buildResponseGroupKeys,
  currentValueEquivalences,
  groupValueEquivalencesByField,
  valueClassKeys,
  valueEquivalenceEdges,
  type EquivalenceEdge,
  type ValueEquivalence,
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

const HASH = "aaaaaaaaaaaa";

function equivalence(
  valueA: unknown,
  valueB: unknown,
  over: Partial<ValueEquivalence> = {},
): ValueEquivalence {
  return {
    id: `eq-${String(valueA)}-${String(valueB)}`,
    field_name: "q",
    field_hash: HASH,
    value_a: valueA,
    value_b: valueB,
    reviewer_id: "rev",
    ...over,
  };
}

describe("currentValueEquivalences", () => {
  const eqs = [
    equivalence("NI", "N/A"),
    equivalence("x", "y", { field_hash: "bbbbbbbbbbbb" }),
    equivalence("p", "q", { field_name: "outro" }),
  ];

  it("só as do campo na versão atual da pergunta", () => {
    expect(currentValueEquivalences(eqs, { name: "q", hash: HASH }).map((e) => e.id)).toEqual(["eq-NI-N/A"]);
  });

  it("campo fora do schema ou sem hash não prova a versão: nenhuma vale", () => {
    expect(currentValueEquivalences(eqs, undefined)).toEqual([]);
    expect(currentValueEquivalences(eqs, { name: "q", hash: undefined })).toEqual([]);
  });
});

describe("valueClassKeys", () => {
  it("fecho transitivo entre valores e normalização da Comparação", () => {
    const classes = valueClassKeys([
      equivalence("Não informado", "NI"),
      equivalence("ni", "N/A"),
      equivalence("sim", "yes"),
    ]);
    const naoInformado = classes.get(JSON.stringify("nao informado"));
    expect(naoInformado).toBeDefined();
    // "NI" e "ni" são a mesma chave normalizada, e a cadeia funde N/A.
    expect(classes.get(JSON.stringify("ni"))).toBe(naoInformado);
    expect(classes.get(JSON.stringify("n/a"))).toBe(naoInformado);
    expect(classes.get(JSON.stringify("sim"))).not.toBe(naoInformado);
  });
});

describe("groupValueEquivalencesByField", () => {
  it("agrupa por campo e tolera null", () => {
    const byField = groupValueEquivalencesByField([
      equivalence("a", "b"),
      equivalence("c", "d", { field_name: "outro" }),
      equivalence("e", "f"),
    ]);
    expect(byField.get("q")?.map((e) => e.id)).toEqual(["eq-a-b", "eq-e-f"]);
    expect(byField.get("outro")?.length).toBe(1);
    expect(groupValueEquivalencesByField(null).size).toBe(0);
  });
});

describe("valueEquivalenceEdges", () => {
  interface Item {
    id: string;
    answer: unknown;
    current: boolean;
  }
  const field = { name: "q", hash: HASH };
  const edges = (items: Item[], eqs: ValueEquivalence[]) =>
    valueEquivalenceEdges(items, eqs, field, (i) => i.answer, (i) => i.current);

  it("funde respostas cujos valores caem na mesma classe", () => {
    const items: Item[] = [
      { id: "h1", answer: "NI", current: true },
      { id: "llm", answer: "N/A", current: true },
      { id: "h2", answer: "outra", current: true },
    ];
    const keys = buildResponseGroupKeys(items, edges(items, [equivalence("NI", "N/A")]), (i) =>
      JSON.stringify(i.answer),
    );
    expect(classes(keys)).toEqual([["h1", "llm"], ["h2"]]);
  });

  // A equivalência é do projeto: A=C (decidido num documento) e C=B (noutro)
  // fundem A e B num documento que não tem C.
  it("transitividade entre documentos: funde valores sem a ponte presente", () => {
    const items: Item[] = [
      { id: "h1", answer: "A", current: true },
      { id: "llm", answer: "B", current: true },
    ];
    expect(edges(items, [equivalence("A", "C"), equivalence("C", "B")])).toEqual([
      { response_a_id: "h1", response_b_id: "llm" },
    ]);
  });

  it("resposta dada a outra versão da pergunta não é fundida por equivalência", () => {
    const items: Item[] = [
      { id: "h1", answer: "NI", current: false },
      { id: "llm", answer: "N/A", current: true },
    ];
    expect(edges(items, [equivalence("NI", "N/A")])).toEqual([]);
  });

  it("resposta ausente não entra", () => {
    const items: Item[] = [
      { id: "h1", answer: undefined, current: true },
      { id: "llm", answer: "N/A", current: true },
    ];
    expect(edges(items, [equivalence("NI", "N/A")])).toEqual([]);
  });
});

// Equivalência "=" x evento, com a regra real de `answersCurrentQuestion`. A
// matriz no banco (arquivamento no save do schema) está em
// `supabase/tests/judgments_follow_question.test.sql` e
// `value_equivalences.test.sql`.
describe("equivalência \"=\" x evento", () => {
  interface Coded {
    id: string;
    answers: Record<string, unknown>;
    answer_field_hashes: Record<string, string>;
  }
  const eq = equivalence("NI", "N/A");
  const before: Coded[] = [
    { id: "h1", answers: { q: "NI" }, answer_field_hashes: { q: HASH } },
    { id: "llm", answers: { q: "N/A" }, answer_field_hashes: { q: HASH } },
  ];
  const fuses = (fields: Array<{ name: string; hash: string }>, responses: Coded[]) => {
    const field = fields.find((candidate) => candidate.name === "q") as
      | (Parameters<typeof answerGroupKeys>[2] & object)
      | undefined;
    const keys = answerGroupKeys(responses, [eq], field, "q");
    return new Set(responses.map((r) => keys.get(r.id))).size === 1;
  };

  it.each([
    { evento: "rodada nova com a pergunta idêntica", fields: [{ name: "q", hash: HASH }], responses: before, vale: true },
    {
      evento: "execução nova do LLM com o mesmo valor",
      fields: [{ name: "q", hash: HASH }],
      responses: [before[0], { ...before[1], id: "llm-v2" }],
      vale: true,
    },
    {
      evento: "recodificação que reproduz o valor (só caixa e espaços)",
      fields: [{ name: "q", hash: HASH }],
      responses: [{ ...before[0], answers: { q: "  ni " } }, before[1]],
      vale: true,
    },
    { evento: "pergunta alterada", fields: [{ name: "q", hash: "bbbbbbbbbbbb" }], responses: before, vale: false },
    {
      evento: "resposta editada para outro valor",
      fields: [{ name: "q", hash: HASH }],
      responses: [{ ...before[0], answers: { q: "Não informado" } }, before[1]],
      vale: false,
    },
    { evento: "campo renomeado", fields: [{ name: "q2", hash: "cccccccccccc" }], responses: before, vale: false },
    { evento: "campo removido", fields: [], responses: before, vale: false },
  ])("$evento: funde = $vale", ({ fields, responses, vale }) => {
    expect(fuses(fields, responses)).toBe(vale);
  });
});

describe("affectedValueKeys", () => {
  const field = { name: "q", hash: HASH };
  const eqs = [equivalence("NI", "N/A"), equivalence("N/A", "não se aplica"), equivalence("sim", "yes")];

  it("as sementes mais toda a classe de cada uma", () => {
    expect([...affectedValueKeys(eqs, field, ["NI"])].sort()).toEqual(
      [JSON.stringify("n/a"), JSON.stringify("nao se aplica"), JSON.stringify("ni")].sort(),
    );
  });

  it("valor sem equivalência entra sozinho; equivalência de outra versão não expande", () => {
    expect([...affectedValueKeys(eqs, { name: "q", hash: "outra" }, ["NI", "talvez"])].sort()).toEqual(
      [JSON.stringify("ni"), JSON.stringify("talvez")].sort(),
    );
  });
});
