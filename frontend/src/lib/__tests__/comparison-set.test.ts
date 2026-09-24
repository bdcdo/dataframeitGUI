import { describe, it, expect } from "vitest";
import {
  comparisonSet,
  minimumHumansToTrigger,
  type ComparisonCandidate,
  type TriggerRule,
} from "@/lib/comparison-set";
import { buildEquivalenceMap } from "@/lib/compare-divergence";
import { versionGate } from "@/lib/compare-version";
import type { PydanticField } from "@/lib/types";

const HASH = "hash-atual";
const project = {
  pydantic_hash: HASH,
  schema_version_major: 1,
  schema_version_minor: 0,
  schema_version_patch: 0,
};
const { minVersion, ctx: versionCtx } = versionGate(project);

const q1: PydanticField = { id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "text", options: null, description: "", required: true };
const q2: PydanticField = { id: "00000000-0000-4000-8000-000000000002", name: "q2", type: "text", options: null, description: "", required: true };

function human(id: string, answers: Record<string, unknown>, over: Partial<ComparisonCandidate> = {}): ComparisonCandidate {
  return {
    id: `r-${id}`,
    respondent_id: id,
    respondent_type: "humano",
    is_latest: true,
    is_partial: false,
    answers,
    answer_field_hashes: null,
    pydantic_hash: HASH,
    schema_version_major: 1,
    schema_version_minor: 0,
    schema_version_patch: 0,
    ...over,
  };
}

function llm(answers: Record<string, unknown>, over: Partial<ComparisonCandidate> = {}): ComparisonCandidate {
  return { ...human("llm", answers, over), id: "r-llm", respondent_id: null, respondent_type: "llm", ...over };
}

function setOf(responses: ComparisonCandidate[], fields: PydanticField[] = [q1], equivalences?: Parameters<typeof buildEquivalenceMap>[0]) {
  return comparisonSet({
    fields,
    responses,
    minVersion,
    versionCtx,
    equivalencesByField: equivalences ? buildEquivalenceMap(equivalences).get("doc1") : undefined,
  });
}

const humansRule: TriggerRule = { mode: "compare_humans", minResponsesForComparison: 2, comparisonIncludesLlm: false };

describe("comparisonSet: respostas que contam", () => {
  it("codificação parcial fica fora; a completa no envio conta mesmo sem a obrigatória criada depois", () => {
    // Ana enviou quando só existia q1 (carimbo sem q2); Beto já respondeu q2.
    const ana = human("ana", { q1: "A" }, { answer_field_hashes: { q1: "h-q1" } });
    const beto = human("beto", { q1: "B", q2: "sim" }, { answer_field_hashes: { q1: "h-q1", q2: "h-q2" } });
    const caio = human("caio", { q1: "C" }, { is_partial: true });
    const set = setOf([ana, beto, caio], [q1, q2]);

    expect(set.counted.map((r) => r.id)).toEqual(["r-ana", "r-beto"]);
    // q2 não diverge: Ana respondeu antes de q2 existir.
    expect(set.toResolve).toEqual(["q1"]);
    expect(set.trigger(humansRule)).toEqual({ kind: "divergent", divergentFields: ["q1"] });
  });

  it("resposta abaixo do piso de versão não conta, humana ou LLM", () => {
    const antiga = { schema_version_major: 0, schema_version_minor: 9, schema_version_patch: 0 };
    const set = setOf([human("ana", { q1: "A" }), human("beto", { q1: "B" }, antiga), llm({ q1: "C" }, antiga)]);

    expect(set.counted.map((r) => r.id)).toEqual(["r-ana"]);
    expect(set.toResolve).toEqual([]);
  });

  it("conta humanos distintos, não linhas", () => {
    const set = setOf([human("ana", { q1: "A" }), human("ana", { q1: "B" }, { id: "r-ana-2" })]);

    expect(set.counted).toHaveLength(2);
    expect(set.humanRespondentCount).toBe(1);
    expect(set.trigger(humansRule)).toMatchObject({ kind: "insufficient", reason: "few_humans", humans: 1, minHumans: 2 });
  });
});

describe("comparisonSet: disparo e resolução", () => {
  it("com o LLM fora do disparo, a divergência só do LLM não abre, mas fica para resolver", () => {
    const set = setOf([human("ana", { q1: "A" }), human("beto", { q1: "A" }), llm({ q1: "X" })]);

    expect(set.toResolve).toEqual(["q1"]);
    expect(set.trigger(humansRule)).toEqual({ kind: "consensus" });
    expect(set.trigger({ ...humansRule, comparisonIncludesLlm: true })).toEqual({
      kind: "divergent",
      divergentFields: ["q1"],
    });
  });

  it("compare_llm exige LLM que conta e basta 1 humano", () => {
    const rule: TriggerRule = { mode: "compare_llm", minResponsesForComparison: 5, comparisonIncludesLlm: false };
    const semLlm = setOf([human("ana", { q1: "A" })]);
    const llmParcial = setOf([human("ana", { q1: "A" }), llm({ q1: "X" }, { is_partial: true })]);
    const comLlm = setOf([human("ana", { q1: "A" }), llm({ q1: "X" })]);

    expect(semLlm.trigger(rule)).toMatchObject({ kind: "insufficient", reason: "no_llm" });
    expect(llmParcial.trigger(rule)).toMatchObject({ kind: "insufficient", reason: "no_llm" });
    expect(comLlm.trigger(rule)).toEqual({ kind: "divergent", divergentFields: ["q1"] });
  });

  it("mínimo de 1 humano sem LLM não tem par para comparar", () => {
    const set = setOf([human("ana", { q1: "A" })]);

    expect(set.trigger({ ...humansRule, minResponsesForComparison: 1 })).toMatchObject({
      kind: "insufficient",
      reason: "needs_two_responses",
    });
  });

  it("equivalência registrada funde a divergência no disparo e na resolução", () => {
    const ana = human("ana", { q1: "não informado" });
    const beto = human("beto", { q1: "NI" });
    const equivalence = {
      id: "eq1",
      document_id: "doc1",
      field_name: "q1",
      response_a_id: ana.id,
      response_b_id: beto.id,
      reviewer_id: "rev",
      response_a_answer_snapshot: "não informado",
      response_b_answer_snapshot: "NI",
    };

    expect(setOf([ana, beto]).toResolve).toEqual(["q1"]);
    const fundido = setOf([ana, beto], [q1], [equivalence]);
    expect(fundido.toResolve).toEqual([]);
    expect(fundido.trigger(humansRule)).toEqual({ kind: "consensus" });
  });
});

describe("minimumHumansToTrigger", () => {
  it("compare_humans usa o mínimo do projeto, com 2 por padrão; compare_llm pede 1", () => {
    expect(minimumHumansToTrigger({ mode: "compare_humans", minResponsesForComparison: 3 })).toBe(3);
    expect(minimumHumansToTrigger({ mode: "compare_humans", minResponsesForComparison: null })).toBe(2);
    expect(minimumHumansToTrigger({ mode: "compare_llm", minResponsesForComparison: 3 })).toBe(1);
  });
});
