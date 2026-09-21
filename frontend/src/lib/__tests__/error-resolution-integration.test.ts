import { describe, expect, it } from "vitest";
import { resolutionFixture } from "./error-resolution-fixture";
import { assembleExport } from "@/lib/export/assemble";
import { computeReviewedDocuments, currentRoundReviews, type ReviewComputationContext } from "@/lib/reviews/queries";
import { computeLlmErrorMetrics, type MetricsResponse, type MetricsFinalAnswer } from "@/lib/llm-error-metrics";
import type { ErrorDecision, ErrorResolutionRow } from "@/lib/error-resolution";
import type { PydanticField } from "@/lib/types";

const field: PydanticField = { name: "x", type: "text", description: "Pergunta", options: null };
const responses = [
  { id: "rllm", respondent_type: "llm" as const, respondent_id: null, answers: { x: "LLM" } },
  { id: "rh", respondent_type: "humano" as const, respondent_id: "person", answers: { x: "Humano" } },
].map((r) => ({ ...r, document_id: "doc1", respondent_name: r.respondent_type,
  is_latest: true, justifications: null, created_at: "2026-09-01T00:00:00Z", pydantic_hash: null,
  answer_field_hashes: {}, schema_version_major: null, schema_version_minor: null, schema_version_patch: null }));
const review = { id: "review1", document_id: "doc1", field_name: "x", verdict: "Humano",
  chosen_response_id: "rh", comment: "Revisão original", reviewer_id: "person", created_at: "2026-09-02T00:00:00Z",
  round_id: "round1" };
const currentRoundId = "round1";

function results(resolutions: ErrorResolutionRow[], autoReview = false, llmValue: unknown = "LLM", reviewRoundId = "round1") {
  const currentResponses = responses.map((r) => r.respondent_type === "llm" ? { ...r, answers: { x: llmValue } } : r);
  const reviews = autoReview ? [] : [{ ...review, round_id: reviewRoundId }];
  const finalAnswers: MetricsFinalAnswer[] = autoReview ? [{ field_review_id: "fr", document_id: "doc1", field_name: "x",
    provenance: "arbitrado", final_verdict: "humano", self_reviewed_at: "2026-09-02T00:00:00Z",
    final_decided_at: "2026-09-03T00:00:00Z", human_response_id: "rh", llm_response_id: "rllm",
    human_answer_snapshot: "Humano", llm_answer_snapshot: "LLM", arbitrator_comment: null }] : [];
  const metrics = computeLlmErrorMetrics({ fields: [field], automationMode: autoReview ? "auto_review_llm" : "compare_llm", currentRoundId,
    documentTitles: new Map([["doc1", "Documento"]]), responses: currentResponses as MetricsResponse[], reviews, finalAnswers,
    equivalences: [], errorResolutions: new Map(resolutions.map((r) => [`${r.document_id}:${r.field_name}`, r])) });
  const exported = assembleExport({ projectName: "Projeto", fields: [field], minResponses: 2, currentRoundId,
    documents: [{ id: "doc1", external_id: "EXT-1", title: "Documento", created_at: "2026-09-01", metadata: null }],
    responses: currentResponses, reviews, errorResolutions: resolutions });
  const ctx: ReviewComputationContext = { fields: [field], comparableFields: [field],
    projectPydanticHash: null, currentFieldHashes: {}, fieldMap: new Map([["x", field]]),
    docMap: new Map([["doc1", "Documento"]]), responsesByDoc: new Map([["doc1", currentResponses]]),
    uniqueReviews: currentRoundReviews(reviews, currentRoundId), errorResolutions: resolutions, profileMap: new Map(),
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
  it("ambos corretos sobre célula de rodada antiga na Comparação não inventa gabarito", () => {
    const r = results([resolutionFixture("both_correct")], false, "LLM", "round0");
    expect(r.gabarito).toEqual([]);
    const cell = r.exported.verdicts.rows[0]?.[r.exported.verdicts.headers.indexOf("x")];
    expect(cell ?? "").toBe("");
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

describe("rodada corrente (#733)", () => {
  it("arbitragem de rodada anterior sai da métrica, do CSV e do Gabarito", () => {
    const r = results([], false, "LLM", "round0");
    expect(r.metrics.errors).toEqual([]);
    expect(r.metrics.reviewedEntries).toEqual([]);
    expect(r.exported.verdicts.rows).toEqual([]);
    expect(r.gabarito).toEqual([]);
  });
  it("decisão gravada sobre célula de rodada antiga continua valendo nos três", () => {
    const row = resolutionFixture("researchers_correct");
    const r = results([row], false, "LLM", "round0");
    expect(r.metrics.errors).toHaveLength(1);
    expect(r.metrics.errors[0].resolution).toEqual(row);
    expect(r.exported.verdicts.rows[0][r.exported.verdicts.headers.indexOf("x")]).toBe("Veredito");
    expect(r.gabarito[0].fields[0].verdict).toBe("Veredito");
    expect(r.gabarito[0].fields[0].resolutionLabel).toBeTruthy();
  });
});
