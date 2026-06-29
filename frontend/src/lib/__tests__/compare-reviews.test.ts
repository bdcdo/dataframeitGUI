import { describe, it, expect } from "vitest";
import {
  mergeReviews,
  type ReviewsByDoc,
  type VerdictInfo,
} from "@/lib/compare-reviews";

const v = (verdict: string, comment: string | null = null): VerdictInfo => ({
  verdict,
  chosenResponseId: null,
  comment,
});

describe("mergeReviews", () => {
  it("retorna a MESMA referência de `existing` quando não há overrides", () => {
    const existing: ReviewsByDoc = { doc1: { campoA: v("deferido") } };
    const merged = mergeReviews(existing, {});
    // Identidade referencial importa: o useMemo a jusante não deve invalidar.
    expect(merged).toBe(existing);
  });

  it("adiciona um veredito novo num documento já existente sem perder os antigos", () => {
    const existing: ReviewsByDoc = { doc1: { campoA: v("deferido") } };
    const overrides: ReviewsByDoc = { doc1: { campoB: v("indeferido") } };
    const merged = mergeReviews(existing, overrides);

    expect(merged.doc1).toEqual({
      campoA: v("deferido"),
      campoB: v("indeferido"),
    });
    // Não muta a entrada original.
    expect(existing.doc1).toEqual({ campoA: v("deferido") });
  });

  it("override substitui o veredito do mesmo campo", () => {
    const existing: ReviewsByDoc = { doc1: { campoA: v("deferido") } };
    const overrides: ReviewsByDoc = {
      doc1: { campoA: v("indeferido", "revisado") },
    };
    const merged = mergeReviews(existing, overrides);

    expect(merged.doc1.campoA).toEqual(v("indeferido", "revisado"));
  });

  it("introduz um documento que só existe nos overrides", () => {
    const existing: ReviewsByDoc = { doc1: { campoA: v("deferido") } };
    const overrides: ReviewsByDoc = { doc2: { campoX: v("ambiguo") } };
    const merged = mergeReviews(existing, overrides);

    expect(merged.doc1).toEqual({ campoA: v("deferido") });
    expect(merged.doc2).toEqual({ campoX: v("ambiguo") });
  });

  it("um campo NÃO sobrescrito reflete a mudança vinda do servidor (existing)", () => {
    // Cenário do bug latente: o servidor revalidou e trouxe o veredito de outro
    // revisor em campoA; o override local só tocou campoB. A visão mesclada
    // deve refletir o campoA novo do servidor.
    const existing: ReviewsByDoc = {
      doc1: { campoA: v("deferido", "por outro revisor") },
    };
    const overrides: ReviewsByDoc = { doc1: { campoB: v("pular") } };
    const merged = mergeReviews(existing, overrides);

    expect(merged.doc1.campoA).toEqual(v("deferido", "por outro revisor"));
    expect(merged.doc1.campoB).toEqual(v("pular"));
  });
});
