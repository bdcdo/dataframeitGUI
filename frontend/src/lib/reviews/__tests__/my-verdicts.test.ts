import { describe, it, expect } from "vitest";
import { buildMyVerdictItems, type MyVerdictReviewRow } from "@/lib/reviews/my-verdicts";
import type { PydanticField } from "@/lib/types";

const field: PydanticField = {
  id: "00000000-0000-4000-8000-000000000001", name: "q", type: "single",
  options: ["Sim", "Não"], description: "Pergunta", hash: "aaaaaaaaaaaa",
};

function review(overrides: Partial<MyVerdictReviewRow> = {}): MyVerdictReviewRow {
  return {
    id: "rv1", document_id: "d1", field_name: "q", verdict: "Sim", comment: null,
    response_snapshot: null, created_at: "2026-01-01T00:00:00Z", field_hash: "aaaaaaaaaaaa", chosen_response_id: "rc", ...overrides,
  };
}

function build(reviews: MyVerdictReviewRow[], answers: Record<string, unknown> = { q: "Não" }, acknowledgedVerdict = "Sim") {
  return buildMyVerdictItems({
    reviews, fields: [field],
    myAnswersByDoc: new Map([["d1", answers]]),
    docTitles: new Map([["d1", "Documento"]]),
    acknowledgments: new Map([["rv1", { status: "questioned", comment: "por quê?", acknowledged_verdict: acknowledgedVerdict }]]),
  });
}

describe("buildMyVerdictItems (#758)", () => {
  it("veredito válido vira item, com correção e ciência do respondente", () => {
    expect(build([review()])).toEqual([expect.objectContaining({
      reviewId: "rv1", documentTitle: "Documento", fieldDescription: "Pergunta", fieldType: "single",
      verdict: "Sim", myAnswer: "Não", isCorrect: false,
      acknowledgmentStatus: "questioned", acknowledgmentComment: "por quê?", acknowledgmentOutdated: false,
    })]);
  });

  // #758: a rearbitragem reaproveita o id da review. O reconhecimento dado ao
  // veredito anterior não vale para o novo: o item volta a pendente e avisa.
  it("reconhecimento de um veredito que mudou volta a pendente", () => {
    expect(build([review({ verdict: "Sim" })], { q: "Não" }, "Não")).toEqual([expect.objectContaining({
      verdict: "Sim", acknowledgmentStatus: null, acknowledgmentComment: null, acknowledgmentOutdated: true,
    })]);
  });

  it.each([
    ["pergunta alterada", review({ field_hash: "ffffffffffff" })],
    ["fora das opções atuais", review({ field_hash: null, verdict: "Talvez" })],
    ["campo removido", review({ field_name: "sumiu" })],
  ])("%s: o veredito não é mais gabarito e não aparece", (_label, stale) => {
    expect(build([stale], { q: "Não", sumiu: "x" })).toEqual([]);
  });

  it("uma célula, um veredito: o mesmo que o Gabarito mostra", () => {
    const items = build([
      review({ id: "velho", verdict: "Não", created_at: "2026-01-01T00:00:00Z" }),
      review({ id: "novo", verdict: "Sim", created_at: "2026-02-01T00:00:00Z" }),
    ]);
    expect(items.map((i) => i.reviewId)).toEqual(["novo"]);
  });

  it("sem resposta do respondente no campo, nenhum item", () => {
    expect(build([review()], {})).toEqual([]);
  });
});
