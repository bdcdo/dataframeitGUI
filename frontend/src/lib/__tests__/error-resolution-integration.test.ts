import { describe, expect, it } from "vitest";
import { resolutionFixture } from "./error-resolution-fixture";
import { assembleExport } from "@/lib/export/assemble";
import { computeReviewedDocuments, gabaritoReviews, isAnswerCorrect, type ReviewComputationContext } from "@/lib/reviews/queries";
import { reviewIsValid } from "@/lib/review-validity";
import { computeLlmErrorMetrics, type MetricsResponse, type MetricsFinalAnswer } from "@/lib/llm-error-metrics";
import type { ErrorDecision, ErrorResolutionRow } from "@/lib/error-resolution";
import type { PydanticField } from "@/lib/types";

const field: PydanticField = { id: "00000000-0000-4000-8000-000000000001", name: "x", type: "text", description: "Pergunta", options: null };
const responses = [
  { id: "rllm", respondent_type: "llm" as const, respondent_id: null, answers: { x: "LLM" } },
  { id: "rh", respondent_type: "humano" as const, respondent_id: "person", answers: { x: "Humano" } },
].map((r) => ({ ...r, document_id: "doc1", respondent_name: r.respondent_type,
  is_latest: true, justifications: null, created_at: "2026-09-01T00:00:00Z", pydantic_hash: null,
  answer_field_hashes: {}, schema_version_major: null, schema_version_minor: null, schema_version_patch: null }));
const review = { id: "review1", document_id: "doc1", field_name: "x", verdict: "Humano",
  chosen_response_id: "rh", comment: "Revisão original", reviewer_id: "person", created_at: "2026-09-02T00:00:00Z",
  field_hash: null as string | null };
// Hash de outra versão da pergunta: o veredito carimbado com ele perdeu a validade.
const OTHER_QUESTION = "ffffffffffff";
// Resposta do LLM sem a chave do campo: o que a condicional não acionada grava.
const ABSENT = Symbol("chave ausente");

function results(resolutions: ErrorResolutionRow[], autoReview = false, llmValue: unknown = "LLM", reviewFieldHash: string | null = null,
  human: { value: unknown; verdict: string; chosenResponseId?: string } = { value: "Humano", verdict: "Humano" }) {
  const answersOf = (value: unknown) => (value === ABSENT ? {} : { x: value });
  const currentResponses = responses.map((r) => ({ ...r, answers: answersOf(r.respondent_type === "llm" ? llmValue : human.value) }));
  const reviews = autoReview ? [] : [{ ...review, field_hash: reviewFieldHash, verdict: human.verdict,
    chosen_response_id: human.chosenResponseId ?? review.chosen_response_id }];
  const finalAnswers: MetricsFinalAnswer[] = autoReview ? [{ field_review_id: "fr", document_id: "doc1", field_name: "x",
    provenance: "arbitrado", final_verdict: "humano", self_reviewed_at: "2026-09-02T00:00:00Z",
    final_decided_at: "2026-09-03T00:00:00Z", human_response_id: "rh", llm_response_id: "rllm",
    human_answer_snapshot: "Humano", llm_answer_snapshot: "LLM", arbitrator_comment: null }] : [];
  const metrics = computeLlmErrorMetrics({ fields: [field], automationMode: autoReview ? "auto_review_llm" : "compare_llm",
    documentTitles: new Map([["doc1", "Documento"]]), responses: currentResponses as MetricsResponse[], reviews, finalAnswers,
    equivalences: [], errorResolutions: new Map(resolutions.map((r) => [`${r.document_id}:${r.field_name}`, r])) });
  const exported = assembleExport({ projectName: "Projeto", fields: [field], minResponses: 2,
    documents: [{ id: "doc1", external_id: "EXT-1", title: "Documento", created_at: "2026-09-01", metadata: null }],
    responses: currentResponses, reviews, errorResolutions: resolutions });
  const ctx: ReviewComputationContext = { fields: [field], comparableFields: [field],
    projectPydanticHash: null, currentFieldHashes: {}, fieldMap: new Map([["x", field]]),
    docMap: new Map([["doc1", "Documento"]]), responsesByDoc: new Map([["doc1", currentResponses]]),
    uniqueReviews: gabaritoReviews(reviews, new Map([["x", field]])),
    validReviewIds: new Set(reviews.filter((r) => reviewIsValid(r, field)).map((r) => r.id)),
    errorResolutions: resolutions, profileMap: new Map(),
    truncated: { responses: false, reviews: false, documents: false } };
  return { metrics, exported, gabarito: computeReviewedDocuments(ctx) };
}

describe.each([false, true])("a decisão atravessa os consumidores, auto-revisão=%s", (autoReview) => {
  it.each<[ErrorDecision, string, boolean, boolean]>([
    ["llm_correct", "LLM", false, false],
    ["researchers_correct", "Veredito", true, false],
    // O veredito ("Humano") segue no gabarito e o LLM deixa de ser erro.
    ["both_correct", "Humano", false, false],
    ["all_wrong", "Terceira", true, false],
    ["discussion", "", true, true],
  ])("%s concorda no gabarito, na métrica e no CSV", (decision, value, isError, isPending) => {
    const row = resolutionFixture(decision);
    if (autoReview) {
      row.context!.automation_mode = "auto_review_llm";
      row.context!.source = { kind: "auto_revisao", id: "fr" };
      row.current_context = structuredClone(row.context);
    }
    const before = structuredClone(responses);
    const { metrics, exported, gabarito } = results([row], autoReview);
    expect(metrics.reviewedEntries[0]).toMatchObject({ isError, isPending });
    expect(metrics.errors).toHaveLength(1);
    expect(metrics.errors[0].resolution).toEqual(row);
    expect(exported.verdicts.rows[0][exported.verdicts.headers.indexOf("x")]).toBe(value);
    const csvFinal = exported.csv.rows.find((r) => r[exported.csv.headers.indexOf("source")] === "comparacao")!;
    expect(csvFinal[exported.csv.headers.indexOf("x")]).toBe(value);
    expect(csvFinal[exported.csv.headers.indexOf("reviewer_comments")]).toContain("[x]");
    expect(gabarito[0].fields[0].verdict).toBe(isPending ? "ambiguo" : value);
    expect(gabarito[0].fields[0].resolutionLabel).toBeTruthy();
    expect(responses).toEqual(before);
    expect(exported.responses.rows.map((r) => r[exported.responses.headers.indexOf("x")])).toEqual(["LLM", "Humano"]);
  });
});

describe("precedência e contexto", () => {
  it.each([{ nome: "Ana" }, "ambiguo", "pular"])("a resposta aprovada %j é correta sem virar sentinela", (value) => {
    const row = resolutionFixture();
    row.context!.llm_value.value = value;
    row.current_context = structuredClone(row.context);
    const { gabarito } = results([row], false, value);
    const fieldResult = gabarito[0].fields[0];
    expect(fieldResult.respondentAnswers.find((r) => r.respondentType === "llm")!.isCorrect).toBe(true);
    expect(fieldResult.respondentAnswers.find((r) => r.respondentType === "humano")!.isCorrect).toBe(false);
  });
  it.each([false, true])("ambos corretos marca LLM e humano como corretos no Gabarito, auto-revisão=%s", (autoReview) => {
    const row = resolutionFixture("both_correct");
    if (autoReview) {
      row.context!.source = { kind: "auto_revisao", id: "fr" };
      row.current_context = structuredClone(row.context);
    }
    const answers = results([row], autoReview).gabarito[0].fields[0].respondentAnswers;
    expect(answers.map((a) => a.isCorrect)).toEqual([true, true]);
  });
  it("todos errados marca LLM e humano como errados no Gabarito", () => {
    const answers = results([resolutionFixture("all_wrong")]).gabarito[0].fields[0].respondentAnswers;
    expect(answers.map((a) => a.isCorrect)).toEqual([false, false]);
  });
  it("ambos corretos sobre veredito que perdeu a validade não inventa gabarito", () => {
    const r = results([resolutionFixture("both_correct")], false, "LLM", OTHER_QUESTION);
    expect(r.gabarito).toEqual([]);
    // Nem linha só com o comentário: o export acompanha a tela.
    expect(r.exported.verdicts.rows).toEqual([]);
  });
  it("discussão bloqueia o gabarito original; reabrir o restaura", () => {
    expect(results([resolutionFixture("discussion")]).exported.verdicts.rows[0][3]).toBe("");
    expect(results([]).gabarito[0].fields[0].verdict).toBe("Humano");
    expect(results([]).metrics.reviewedEntries[0].isError).toBe(true);
  });
  it("fontes alteradas retiram o efeito sem apagar a resolução", () => {
    const row = resolutionFixture();
    row.current_context = null;
    const r = results([row]);
    expect(r.gabarito[0].fields[0].verdict).toBe("Humano");
    expect(r.exported.verdicts.rows[0][3]).toBe("Humano");
    expect(r.metrics.errors[0].resolution).toEqual(row);
  });
  it("não aplica decisão de outro documento", () => {
    const row = resolutionFixture();
    row.document_id = "other";
    expect(results([row]).gabarito[0].fields[0].verdict).toBe("Humano");
    expect(results([row]).exported.verdicts.rows[0][3]).toBe("Humano");
  });
});

describe("veredito que perdeu a validade (#758)", () => {
  it("arbitragem sobre outra versão da pergunta sai da métrica, do CSV e do Gabarito", () => {
    const r = results([], false, "LLM", OTHER_QUESTION);
    expect(r.metrics.errors).toEqual([]);
    expect(r.metrics.reviewedEntries).toEqual([]);
    expect(r.exported.verdicts.rows).toEqual([]);
    expect(r.gabarito).toEqual([]);
  });
  it("Em discussão sobre veredito que perdeu a validade não vale em nenhum dos três", () => {
    const r = results([resolutionFixture("discussion")], false, "LLM", OTHER_QUESTION);
    expect(r.gabarito).toEqual([]);
    expect(r.exported.verdicts.rows).toEqual([]);
    expect(r.metrics.reviewedEntries).toEqual([]);
  });
  it("decisão com valor próprio sobre veredito que perdeu a validade continua valendo nos três", () => {
    const row = resolutionFixture("researchers_correct");
    const r = results([row], false, "LLM", OTHER_QUESTION);
    expect(r.metrics.errors).toHaveLength(1);
    expect(r.metrics.errors[0].resolution).toEqual(row);
    expect(r.exported.verdicts.rows[0][r.exported.verdicts.headers.indexOf("x")]).toBe("Veredito");
    expect(r.gabarito[0].fields[0].verdict).toBe("Veredito");
    expect(r.gabarito[0].fields[0].resolutionLabel).toBeTruthy();
  });
});

describe("resposta em branco em pergunta condicional", () => {
  it("Todos errados em branco: célula vazia no export, e LLM e humano que responderam erram no Gabarito", () => {
    const row = { ...resolutionFixture("all_wrong"), approved_value: "" };
    const { metrics, exported, gabarito } = results([row]);
    expect(metrics.reviewedEntries[0]).toMatchObject({ isError: true, isPending: false });
    expect(exported.verdicts.rows[0][exported.verdicts.headers.indexOf("x")]).toBe("");
    expect(gabarito[0].fields[0].respondentAnswers.map((a) => a.isCorrect)).toEqual([false, false]);
  });

  // Veredito "" de quem votou no grupo em branco, e o LLM sem a chave: métrica
  // e Gabarito concordam que não houve erro.
  it.each<[string, unknown]>([["ausente", ABSENT], ["null", null], ["\"\"", ""]])(
    "sem decisão, humano escolhido em branco (%s) e LLM sem a chave: nem erro na métrica, nem incorreto no Gabarito",
    (_forma, humanValue) => {
      const { metrics, gabarito } = results([], false, ABSENT, null, { value: humanValue, verdict: "" });
      expect(metrics.reviewedEntries[0]).toMatchObject({ isError: false });
      expect(metrics.errors).toHaveLength(0);
      expect(gabarito[0].fields[0].respondentAnswers.map((a) => a.isCorrect)).toEqual([true, true]);
    });

  it("sem decisão, veredito em branco e LLM respondendo segue erro do LLM", () => {
    const { metrics } = results([], false, "LLM", null, { value: "", verdict: "" });
    expect(metrics.reviewedEntries[0]).toMatchObject({ isError: true });
  });

  // O branco só absolve o LLM quando o lado escolhido também está em branco.
  it("sem decisão, LLM sem a chave e humano escolhido respondendo: erro do LLM na métrica e no Gabarito", () => {
    const { metrics, gabarito } = results([], false, ABSENT);
    expect(metrics.reviewedEntries[0]).toMatchObject({ isError: true });
    expect(gabarito[0].fields[0].respondentAnswers.map((a) => a.isCorrect)).toEqual([false, true]);
  });

  // Resposta escolhida que sumiu: o lado escolhido é o texto do veredito.
  it.each<[string, string, boolean]>([["preenchido", "Humano", true], ["em branco", "", false]])(
    "sem decisão, resposta escolhida sumida e veredito %s, com o LLM sem a chave",
    (_forma, verdict, isError) => {
      const { metrics } = results([], false, ABSENT, null, { value: "Humano", verdict, chosenResponseId: "sumiu" });
      expect(metrics.reviewedEntries[0]).toMatchObject({ isError });
    });

  it("Erro humano com o LLM fora da condicional aprova o branco nos três consumidores", () => {
    const row = resolutionFixture("llm_correct");
    row.context!.field_definition = { name: "x", type: "text", description: "Pergunta", options: null, condition: { field: "g0", equals: "Sim" } };
    row.context!.llm_value = { present: false, value: null };
    row.current_context = structuredClone(row.context);
    const { metrics, exported, gabarito } = results([row], false, ABSENT);
    expect(metrics.reviewedEntries[0]).toMatchObject({ isError: false, isPending: false });
    expect(exported.verdicts.rows[0][exported.verdicts.headers.indexOf("x")]).toBe("");
    expect(gabarito[0].fields[0].verdict).toBe("");
    const answers = gabarito[0].fields[0].respondentAnswers;
    expect(answers.map((a) => a.isCorrect)).toEqual([true, false]);
  });
});

describe("Gabarito: as formas de vazio são a mesma resposta, com ou sem decisão", () => {
  // Votar na Comparação no grupo em que a resposta está ausente grava o
  // veredito "", e quem deixou a chave de fora concorda com ele.
  it.each(["single", "text", "date", "multi"] as const)("sem decisão, veredito \"\" e resposta ausente, null ou \"\" (%s)", (fieldType) => {
    expect(isAnswerCorrect(undefined, "", fieldType)).toBe(true);
    expect(isAnswerCorrect(null, "", fieldType)).toBe(true);
    expect(isAnswerCorrect("", "", fieldType)).toBe(true);
    expect(isAnswerCorrect("A", "", fieldType)).toBe(false);
    expect(isAnswerCorrect(undefined, "A", fieldType)).toBe(false);
  });

  // `multi` sem opções é votado como texto: o grupo da resposta vazia grava "".
  it("multi: veredito \"\" e resposta [] são a mesma resposta vazia", () => {
    expect(isAnswerCorrect([], "", "multi")).toBe(true);
    expect(isAnswerCorrect(["A"], "", "multi")).toBe(false);
  });

  it("Ambos corretos com o LLM em branco num campo sem condição: vazio contra vazio é correto", () => {
    const row = resolutionFixture("both_correct");
    row.context!.llm_value = { present: true, value: "" };
    row.current_context = structuredClone(row.context);
    const { gabarito } = results([row], false, "");
    expect(gabarito[0].fields[0].respondentAnswers.find((a) => a.respondentType === "llm")!.isCorrect).toBe(true);
  });
});
