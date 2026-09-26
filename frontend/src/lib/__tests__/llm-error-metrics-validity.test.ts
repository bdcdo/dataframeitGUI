// A métrica e a fila do LLM Insights sob a regra única de validade do veredito
// (`review-validity.ts`): o veredito vale enquanto a pergunta não muda, a
// rodada não entra na regra, e o LLM é medido contra o VALOR do veredito, não
// contra a resposta atual de quem foi escolhido.
import { describe, it, expect } from "vitest";
import {
  computeLlmErrorMetrics,
  type LlmErrorMetricsInput,
  type MetricsEquivalence,
  type MetricsResponse,
  type MetricsReview,
} from "@/lib/llm-error-metrics";
import type { ErrorDecision, ErrorResolutionRow } from "@/lib/error-resolution";
import type { PydanticField } from "@/lib/types";
import { resolutionFixture } from "./error-resolution-fixture";

const HASH = "aaaaaaaaaaaa";
const OLD_HASH = "ffffffffffff";

function field(overrides: Partial<PydanticField> = {}): PydanticField {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "x",
    type: "text",
    options: null,
    description: "Pergunta",
    target: "all",
    hash: HASH,
    ...overrides,
  };
}

function response(overrides: Partial<MetricsResponse> = {}): MetricsResponse {
  return {
    id: "rh",
    document_id: "doc1",
    respondent_type: "humano",
    is_latest: true,
    answers: {},
    justifications: null,
    answer_field_hashes: null,
    created_at: "2026-01-01T00:00:00Z",
    schema_version_major: 1,
    schema_version_minor: 0,
    schema_version_patch: 0,
    ...overrides,
  };
}

// `round_id` não faz parte da regra: fica na fixture só para dizer de que
// rodada a arbitragem veio, e provar que ela não pesa.
function review(overrides: Partial<MetricsReview> & { round_id?: string } = {}): MetricsReview {
  return {
    id: "review1",
    document_id: "doc1",
    field_name: "x",
    verdict: "A",
    chosen_response_id: "rh",
    comment: null,
    created_at: "2026-02-01T00:00:00Z",
    field_hash: HASH,
    ...overrides,
  };
}

function equiv(a: string, b: string, snapA: unknown, snapB: unknown): MetricsEquivalence {
  return {
    document_id: "doc1",
    field_name: "x",
    response_a_id: a,
    response_b_id: b,
    response_a_answer_snapshot: snapA,
    response_b_answer_snapshot: snapB,
  };
}

function run(overrides: Partial<LlmErrorMetricsInput> = {}) {
  return computeLlmErrorMetrics({
    fields: [field()],
    automationMode: "compare_llm",
    documentTitles: new Map([["doc1", "Documento 1"]]),
    responses: [],
    reviews: [],
    finalAnswers: [],
    equivalences: [],
    errorResolutions: new Map(),
    // Rodada corrente que a versão anterior filtrava; a regra nova a ignora.
    ...({ currentRoundId: "round1" } as object),
    ...overrides,
  });
}

const llm = (answer: unknown) => response({ id: "rllm", respondent_type: "llm", answers: { x: answer } });

describe("métrica: o LLM é medido contra o valor do veredito", () => {
  it("pesquisador editou a resposta escolhida depois da arbitragem: o LLM que acertou o veredito não erra", () => {
    const { errors, reviewedEntries } = run({
      responses: [llm("A"), response({ answers: { x: "B" } })],
      reviews: [review({ verdict: "A" })],
    });
    expect(errors).toHaveLength(0);
    expect(reviewedEntries).toHaveLength(1);
    expect(reviewedEntries[0].isError).toBe(false);
  });

  it("pesquisador editou para o valor do LLM depois da arbitragem: o veredito continua mandando", () => {
    const { errors } = run({
      responses: [llm("B"), response({ answers: { x: "B" } })],
      reviews: [review({ verdict: "A" })],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].chosenVerdict).toBe("A");
    // A resposta atual da escolhida não é mais o veredito: não pré-marca o seletor.
    expect(errors[0].chosenValue).toBeUndefined();
  });

  it("par = vigente com resposta cujo valor atual é o do veredito tira o erro", () => {
    const { errors } = run({
      responses: [llm("A'"), response({ answers: { x: "A" } })],
      reviews: [review({ verdict: "A" })],
      equivalences: [equiv("rh", "rllm", "A", "A'")],
    });
    expect(errors).toHaveLength(0);
  });

  it("par = com resposta editada para longe do veredito não tira o erro", () => {
    const { errors } = run({
      responses: [llm("B'"), response({ answers: { x: "B" } })],
      reviews: [review({ verdict: "A" })],
      equivalences: [equiv("rh", "rllm", "B", "B'")],
    });
    expect(errors).toHaveLength(1);
  });

  it("veredito votado em card de subcampos casa com a forma exibida no card", () => {
    const { errors } = run({
      responses: [llm({ anos: "2", meses: "3" }), response({ answers: { x: { anos: "2", meses: "3" } } })],
      reviews: [review({ verdict: "anos: 2, meses: 3" })],
    });
    expect(errors).toHaveLength(0);
  });

  it("multi: o JSON de seleção do veredito é o gabarito", () => {
    const multi = field({ type: "multi", options: ["A", "B", "C"] });
    const agree = run({
      fields: [multi],
      responses: [llm(["B", "A"]), response({ answers: { x: ["C"] } })],
      reviews: [review({ verdict: '{"A":true,"B":true,"C":false}' })],
    });
    expect(agree.errors).toHaveLength(0);
    const disagree = run({
      fields: [multi],
      responses: [llm(["A"]), response({ answers: { x: ["A", "B"] } })],
      reviews: [review({ verdict: '{"A":true,"B":true,"C":false}' })],
    });
    expect(disagree.errors).toHaveLength(1);
  });
});

describe("métrica: validade do veredito no lugar da rodada", () => {
  it("pergunta idêntica em rodada anterior continua medindo", () => {
    const { reviewedEntries, errors } = run({
      responses: [llm("B"), response({ answers: { x: "A" } })],
      reviews: [review({ verdict: "A", round_id: "round0" })],
    });
    expect(reviewedEntries).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it.each([
    ["pergunta alterada", review({ verdict: "A", field_hash: OLD_HASH, round_id: "round1" }), [field()]],
    ["campo removido", review({ verdict: "A", field_name: "x", round_id: "round1" }), [field({ name: "outro" })]],
    [
      "veredito fora das opções atuais",
      review({ verdict: "Talvez", field_hash: null, round_id: "round1" }),
      [field({ type: "single", options: ["A", "B"] })],
    ],
  ])("%s sai da métrica, mesmo na rodada corrente", (_label, stale, fields) => {
    const { reviewedEntries, errors } = run({
      fields,
      responses: [llm("B"), response({ answers: { x: "A" } })],
      reviews: [stale],
    });
    expect(reviewedEntries).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it.each([
    ["ambiguo", "ambiguo"],
    ["resposta nova digitada", "Outra coisa"],
  ])("veredito válido mais recente sem resposta escolhida (%s) tira a célula da métrica", (_label, verdict) => {
    const { errors, reviewedEntries } = run({
      responses: [llm("B"), response({ answers: { x: "A" } })],
      reviews: [
        review({ id: "antiga", verdict: "A", created_at: "2026-01-01T00:00:00Z" }),
        review({ id: "nova", verdict, chosen_response_id: null, created_at: "2026-03-01T00:00:00Z" }),
      ],
    });
    expect(errors).toEqual([]);
    expect(reviewedEntries).toEqual([]);
  });
});

function decision(kind: ErrorDecision, sourceId: string, overrides: Partial<ErrorResolutionRow> = {}): ErrorResolutionRow {
  const row = resolutionFixture(kind);
  row.context!.source = { kind: "comparacao", id: sourceId, verdict: "Humano" };
  row.current_context = structuredClone(row.context);
  return { ...row, ...overrides };
}

describe("fila: decisão ressuscitada só enquanto vale", () => {
  // O LLM concorda com o veredito válido corrente, então a célula não é caso
  // vivo: só uma decisão gravada a traria de volta para a fila.
  const base = {
    responses: [llm("A"), response({ answers: { x: "A" } })],
    reviews: [
      review({ id: "valid", verdict: "A", created_at: "2026-03-01T00:00:00Z" }),
      review({ id: "stale", verdict: "B", field_hash: OLD_HASH, reviewer_id: "u2", created_at: "2026-01-01T00:00:00Z" } as Partial<MetricsReview>),
    ],
  };

  // "Ambos corretos" e "Em discussão" sobre fonte inválida ou apagada caem no
  // banco: `read_error_resolutions` não lhes dá contexto corrente (suíte SQL
  // de reviews_field_hash), e a decisão stale cai no teste seguinte.
  it.each<[string, ErrorDecision, string]>([
    ["Erro humano sobre veredito inválido grava valor próprio e fica", "llm_correct", "stale"],
    ["Erro do LLM sobre veredito inválido grava valor próprio e fica", "researchers_correct", "stale"],
    ["Todos errados sobre veredito inválido grava valor próprio e fica", "all_wrong", "stale"],
    ["Ambos corretos sobre veredito válido fica", "both_correct", "valid"],
  ])("%s", (_label, kind, sourceId) => {
    const { errors, lapsedDecisions } = run({
      ...base,
      errorResolutions: new Map([["doc1:x", decision(kind, sourceId)]]),
    });
    expect(errors).toHaveLength(1);
    expect(lapsedDecisions).toHaveLength(0);
  });

  it("decisão stale não volta, mesmo com valor próprio, e entra na contagem das que perderam a validade", () => {
    const stale = decision("llm_correct", "valid", { current_context: null });
    const { errors, lapsedDecisions } = run({ ...base, errorResolutions: new Map([["doc1:x", stale]]) });
    expect(errors).toHaveLength(0);
    expect(lapsedDecisions).toEqual([
      expect.objectContaining({ documentId: "doc1", fieldName: "x", documentTitle: "Documento 1" }),
    ]);
  });

  it("decisão de documento excluído some sem contar como perda de validade", () => {
    const { errors, lapsedDecisions } = run({
      ...base,
      documentTitles: new Map(),
      errorResolutions: new Map([["doc1:x", decision("both_correct", "stale")]]),
    });
    expect(errors).toHaveLength(0);
    expect(lapsedDecisions).toHaveLength(0);
  });

  it("Ambos corretos sobre veredito inválido não tira o erro do caso vivo da célula", () => {
    // O caso vivo vem do veredito válido ("A") contra o LLM ("B"); a decisão
    // gravada foi dada sobre o veredito da pergunta antiga, e o banco não lhe
    // dá contexto corrente.
    const { reviewedEntries } = run({
      responses: [llm("B"), response({ answers: { x: "A" } })],
      reviews: base.reviews,
      errorResolutions: new Map([["doc1:x", decision("both_correct", "stale", { current_context: null })]]),
    });
    expect(reviewedEntries).toEqual([expect.objectContaining({ isError: true })]);
  });
});

describe("fila: decisão ancorada em veredito válido que não é o escolhido da célula", () => {
  // Dois revisores arbitraram a célula, os dois vereditos valem, e a decisão
  // foi dada sobre o mais antigo. A fonte continua válida: a regra é "a fonte
  // vale", e não "a fonte é o veredito que o Gabarito escolheu".
  const reviews = [
    review({ id: "nova", verdict: "A", created_at: "2026-03-01T00:00:00Z" }),
    review({ id: "antiga", verdict: "A", created_at: "2026-01-01T00:00:00Z" }),
  ];

  it("Em discussão continua na fila e continua pendente", () => {
    const { errors, lapsedDecisions, reviewedEntries } = run({
      responses: [llm("B"), response({ answers: { x: "A" } })],
      reviews,
      errorResolutions: new Map([["doc1:x", decision("discussion", "antiga")]]),
    });
    expect(lapsedDecisions).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(reviewedEntries).toEqual([expect.objectContaining({ isPending: true })]);
  });

  it("Ambos corretos ressuscitada fica na fila sem contar como perda de validade", () => {
    const { errors, lapsedDecisions } = run({
      responses: [llm("A"), response({ answers: { x: "A" } })],
      reviews,
      errorResolutions: new Map([["doc1:x", decision("both_correct", "antiga")]]),
    });
    expect(lapsedDecisions).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});

describe("fila: decisão com valor próprio sobre veredito que perdeu a validade", () => {
  const reviews = [
    review({ id: "stale", verdict: "B", field_hash: OLD_HASH, created_at: "2026-01-01T00:00:00Z" }),
  ];

  it.each<[ErrorDecision]>([["llm_correct"], ["researchers_correct"], ["all_wrong"]])(
    "%s volta com o motivo da invalidade da fonte",
    (kind) => {
      const { errors } = run({
        responses: [llm("A"), response({ answers: { x: "A" } })],
        reviews,
        errorResolutions: new Map([["doc1:x", decision(kind, "stale")]]),
      });
      expect(errors).toEqual([expect.objectContaining({ sourceId: "stale", sourceInvalidReason: "pergunta_alterada" })]);
    },
  );

  it("fonte válida não leva motivo", () => {
    const { errors } = run({
      responses: [llm("A"), response({ answers: { x: "A" } })],
      reviews: [review({ id: "valid", verdict: "A" })],
      errorResolutions: new Map([["doc1:x", decision("llm_correct", "valid")]]),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].sourceInvalidReason).toBeUndefined();
  });

  it("veredito fora das opções atuais leva o motivo certo", () => {
    const { errors } = run({
      fields: [field({ type: "single", options: ["A", "B"] })],
      responses: [llm("A"), response({ answers: { x: "A" } })],
      reviews: [review({ id: "fora", verdict: "Talvez", field_hash: null })],
      errorResolutions: new Map([["doc1:x", decision("llm_correct", "fora")]]),
    });
    expect(errors).toEqual([expect.objectContaining({ sourceInvalidReason: "fora_do_dominio" })]);
  });
});
