import { describe, expect, it } from "vitest";
import type { HumanResponseRow, LlmResponseRow } from "@/lib/auto-review-backlog";
import {
  autoReviewCoverageCandidates,
  autoReviewCoverageViolations,
  autoReviewDivergences,
  coverageKey,
  type AutoReviewCoverageInput,
  type AutoReviewReplayInput,
  type CoverageResponseMeta,
} from "@/lib/auto-review-coverage";
import { groupValueEquivalencesByField, type ValueEquivalence } from "@/lib/equivalence";
import type { PydanticField } from "@/lib/types";

// Regra da invariante `divergencia-de-auto-revisao-tem-ciclo-ou-request`
// (#683). Cada falso positivo listado na issue tem um caso aqui: é o que a
// invariante precisa NÃO acusar, e o caso positivo prova que ela acusa o resto.

const field: PydanticField = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "campo1",
  type: "text",
  options: null,
  description: "Campo de teste",
  hash: "campo1-hash",
};
const field2: PydanticField = { ...field, id: "00000000-0000-4000-8000-000000000002", name: "campo2", hash: "campo2-hash" };

function human(over: Partial<HumanResponseRow> = {}): HumanResponseRow {
  return {
    id: "h1",
    document_id: "doc1",
    respondent_id: "ana",
    answers: { campo1: "sim" },
    answer_field_hashes: null,
    ...over,
  };
}

function llm(over: Partial<LlmResponseRow> = {}): LlmResponseRow {
  return { id: "llm1", document_id: "doc1", answers: { campo1: "nao" }, answer_field_hashes: null, ...over };
}

type Scenario = AutoReviewReplayInput & Omit<AutoReviewCoverageInput, "divergences">;

function input(over: Partial<Scenario> = {}): Scenario {
  return {
    projectId: "p1",
    fields: [field],
    humans: [human()],
    llmByDocId: new Map([["doc1", llm()]]),
    equivalencesByField: new Map(),
    openCycles: new Set(),
    pendingLlmOf: new Map(),
    ...over,
  };
}

// O caminho do script: replay e depois cobertura.
function violationsOf(scenario: Scenario) {
  return autoReviewCoverageViolations({ ...scenario, divergences: autoReviewDivergences(scenario) });
}

describe("autoReviewCoverageViolations", () => {
  it("acusa divergência sem ciclo nem request — o trabalho que sumiu", () => {
    expect(violationsOf(input())).toEqual([
      {
        key: "doc1|campo1",
        detail: "doc doc1, campo campo1 (projeto p1): diverge do LLM para ana sem ciclo em field_reviews nem request pendente",
      },
    ]);
  });

  it("aceita a divergência coberta por ciclo operacional do (documento, campo)", () => {
    expect(violationsOf(input({ openCycles: new Set([coverageKey("doc1", "campo1")]) }))).toEqual([]);
  });

  it("cobre por campo: ciclo de outro campo do mesmo documento não basta", () => {
    const violations = violationsOf(
      input({
        fields: [field, field2],
        humans: [human({ answers: { campo1: "sim", campo2: "sim" } })],
        llmByDocId: new Map([["doc1", llm({ answers: { campo1: "nao", campo2: "nao" } })]]),
        openCycles: new Set([coverageKey("doc1", "campo1")]),
      }),
    );
    expect(violations.map((v) => v.key)).toEqual(["doc1|campo2"]);
  });

  it("FP 1 — consenso legítimo não produz linha", () => {
    expect(violationsOf(input({ humans: [human({ answers: { campo1: "nao" } })] }))).toEqual([]);
  });

  it("FP 2 — equivalência de valor declarada pelo revisor entra no replay", () => {
    const equivalence: ValueEquivalence = {
      id: "eq1",
      field_name: "campo1",
      field_hash: field.hash!,
      value_a: "sim",
      value_b: "nao",
      reviewer_id: "rev",
    };
    const equivalencesByField = groupValueEquivalencesByField([equivalence]);
    expect(violationsOf(input({ equivalencesByField }))).toEqual([]);
    // Equivalência de outra versão da pergunta não vale: a divergência volta.
    const stale = groupValueEquivalencesByField([{ ...equivalence, field_hash: "outra-versao" }]);
    expect(violationsOf(input({ equivalencesByField: stale }))).toHaveLength(1);
  });

  it("FP 3 — codificação humana incompleta fica fora", () => {
    expect(violationsOf(input({ humans: [human({ answers: {} })] }))).toEqual([]);
  });

  it("FP 4 — um ciclo por (documento, campo) cobre os dois codificadores, e a violação sai uma vez só", () => {
    const humans = [human(), human({ id: "h2", respondent_id: "bia", answers: { campo1: "talvez" } })];
    expect(
      violationsOf(input({ humans, openCycles: new Set([coverageKey("doc1", "campo1")]) })),
    ).toEqual([]);
    const violations = violationsOf(input({ humans }));
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toContain("para ana, bia");
  });

  it("FP 5 — request pendente para a geração corrente absorve a janela do dreno", () => {
    expect(violationsOf(input({ pendingLlmOf: new Map([["doc1", "llm1"]]) }))).toEqual([]);
  });

  it("request presa a outra geração não cobre: o worker só a reconhece como obsoleta", () => {
    expect(violationsOf(input({ pendingLlmOf: new Map([["doc1", "llm-antiga"]]) }))).toHaveLength(1);
  });

  it("codificador com duas respostas vivas aparece uma vez no detalhe", () => {
    const humans = [human(), human({ id: "h1-rodada-anterior" })];
    expect(violationsOf(input({ humans }))[0].detail).toContain("para ana sem ciclo");
  });

  it("documento sem geração LLM não entra no replay", () => {
    expect(violationsOf(input({ llmByDocId: new Map() }))).toEqual([]);
  });
});

describe("autoReviewCoverageCandidates", () => {
  const meta = (over: Partial<CoverageResponseMeta>): CoverageResponseMeta => ({
    id: "x",
    project_id: "p1",
    document_id: "doc1",
    respondent_type: "humano",
    respondent_id: "ana",
    ...over,
  });
  const members = new Map([["p1", new Set(["ana"])]]);
  const active = new Set(["doc1", "doc2"]);

  it("devolve a geração LLM e as humanas de membros do documento que tem as duas", () => {
    const rows = [
      meta({ id: "llm1", respondent_type: "llm", respondent_id: null }),
      meta({ id: "h1" }),
      meta({ id: "h-fora", respondent_id: "ex-membro" }),
    ];
    expect(autoReviewCoverageCandidates(rows, active, members).map((r) => r.id)).toEqual(["llm1", "h1"]);
  });

  it("descarta documento sem LLM, sem humana de membro, ou excluído", () => {
    const rows = [
      meta({ id: "h-sem-llm" }),
      meta({ id: "llm2", document_id: "doc2", respondent_type: "llm", respondent_id: null }),
      meta({ id: "h-nao-membro", document_id: "doc2", respondent_id: "ex-membro" }),
      meta({ id: "llm3", document_id: "doc3", respondent_type: "llm", respondent_id: null }),
      meta({ id: "h3", document_id: "doc3" }),
    ];
    expect(autoReviewCoverageCandidates(rows, active, members)).toEqual([]);
  });
});
