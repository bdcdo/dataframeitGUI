import { describe, expect, it } from "vitest";
import { classifyResponse } from "../classify";
import type { LlmResponseRecord } from "@/actions/llm";

// Espelha _answers_have_content no backend (services/llm_runner.py). Se um
// teste aqui falhar apos mudar a regra, atualize tambem o backend para
// manter counters live consistentes com badges renderizadas.

function record(
  partial: Partial<LlmResponseRecord> & Pick<LlmResponseRecord, "answers" | "is_partial">
): LlmResponseRecord {
  return {
    id: "r1",
    document_id: "d1",
    llm_job_id: null,
    is_current: true,
    justifications: null,
    respondent_name: null,
    created_at: "2026-05-04T00:00:00Z",
    llm_error: null,
    document: null,
    ...partial,
  };
}

describe("classifyResponse", () => {
  it("retorna empty para answers vazio", () => {
    expect(classifyResponse(record({ answers: {}, is_partial: false }))).toBe(
      "empty"
    );
  });

  it("retorna empty quando todos os valores sao null/undefined", () => {
    expect(
      classifyResponse(
        record({ answers: { a: null, b: undefined }, is_partial: false })
      )
    ).toBe("empty");
  });

  it("retorna empty quando todas as strings sao vazias ou whitespace", () => {
    expect(
      classifyResponse(
        record({ answers: { a: "", b: "   \n" }, is_partial: false })
      )
    ).toBe("empty");
  });

  it("retorna empty quando arrays e objetos sao vazios", () => {
    expect(
      classifyResponse(
        record({ answers: { a: [], b: {} }, is_partial: false })
      )
    ).toBe("empty");
  });

  it("retorna complete quando ha string util e nao parcial", () => {
    expect(
      classifyResponse(record({ answers: { a: "valor" }, is_partial: false }))
    ).toBe("complete");
  });

  it("retorna partial quando ha valor mas is_partial=true", () => {
    expect(
      classifyResponse(record({ answers: { a: "valor" }, is_partial: true }))
    ).toBe("partial");
  });

  it("retorna complete para lista nao vazia", () => {
    expect(
      classifyResponse(record({ answers: { a: ["x"] }, is_partial: false }))
    ).toBe("complete");
  });

  it("retorna complete para dict nao vazio", () => {
    expect(
      classifyResponse(
        record({ answers: { a: { k: "v" } }, is_partial: false })
      )
    ).toBe("complete");
  });

  it("retorna complete para int 0 (valor legitimo)", () => {
    // int 0 e bool false sao respostas validas (quantidade, presenca booleana).
    // Tratar como vazio mascararia respostas reais.
    expect(
      classifyResponse(record({ answers: { a: 0 }, is_partial: false }))
    ).toBe("complete");
  });

  it("retorna complete para bool false", () => {
    expect(
      classifyResponse(record({ answers: { a: false }, is_partial: false }))
    ).toBe("complete");
  });

  it("considera mistura de vazios + 1 valor real como complete", () => {
    expect(
      classifyResponse(
        record({
          answers: { a: "", b: null, c: "ok" },
          is_partial: false,
        })
      )
    ).toBe("complete");
  });

  it("answers null/undefined caem como empty", () => {
    expect(
      classifyResponse(record({ answers: null as unknown as Record<string, unknown>, is_partial: false }))
    ).toBe("empty");
  });
});
