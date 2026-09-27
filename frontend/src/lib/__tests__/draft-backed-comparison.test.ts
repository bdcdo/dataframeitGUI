import { describe, expect, it } from "vitest";
import {
  draftBackedComparisonViolations,
  type DraftBackedComparisonInput,
} from "@/lib/draft-backed-comparison";

// Cenário-base: o doc "rascunho" tem só um rascunho humano e uma comparação
// (violação); o doc "submetido" tem rascunho e codificação submetida (saudável).
function input(overrides: Partial<DraftBackedComparisonInput> = {}): DraftBackedComparisonInput {
  return {
    comparisons: [
      { id: "cmp-rascunho", document_id: "doc-rascunho" },
      { id: "cmp-submetido", document_id: "doc-submetido" },
    ],
    activeDocIds: new Set(["doc-rascunho", "doc-submetido"]),
    humanLatest: [
      { document_id: "doc-rascunho", is_partial: true },
      { document_id: "doc-submetido", is_partial: true },
      { document_id: "doc-submetido", is_partial: false },
    ],
    exceptions: new Map(),
    ...overrides,
  };
}

const keys = (i: DraftBackedComparisonInput) =>
  draftBackedComparisonViolations(i).map((v) => v.key);

describe("draftBackedComparisonViolations", () => {
  it("acusa comparação cujo doc ativo só tem rascunho humano", () => {
    const violations = draftBackedComparisonViolations(input());
    expect(violations).toEqual([
      {
        key: "cmp-rascunho",
        detail: expect.stringContaining("comparação apoiada só em rascunho: doc doc-rascunho tem 1"),
      },
    ]);
  });

  it("ignora doc excluído", () => {
    expect(keys(input({ activeDocIds: new Set(["doc-submetido"]) }))).toEqual([]);
  });

  it("ignora comparação órfã, sem codificação humana nenhuma", () => {
    expect(keys(input({ humanLatest: [] }))).toEqual([]);
  });

  it("conta is_partial null como submetida (linha legada)", () => {
    expect(
      keys(
        input({
          humanLatest: [
            { document_id: "doc-rascunho", is_partial: true },
            { document_id: "doc-rascunho", is_partial: null },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("a exceção suprime a violação listada", () => {
    expect(keys(input({ exceptions: new Map([["cmp-rascunho", "NT-1-SP"]]) }))).toEqual([]);
  });

  it("violação fora da lista continua acusada", () => {
    const i = input({
      comparisons: [
        { id: "cmp-rascunho", document_id: "doc-rascunho" },
        { id: "cmp-outro", document_id: "doc-outro" },
      ],
      activeDocIds: new Set(["doc-rascunho", "doc-outro"]),
      humanLatest: [
        { document_id: "doc-rascunho", is_partial: true },
        { document_id: "doc-outro", is_partial: true },
      ],
      exceptions: new Map([["cmp-rascunho", "NT-1-SP"]]),
    });
    expect(keys(i)).toEqual(["cmp-outro"]);
  });

  describe("exceção obsoleta vira violação", () => {
    it("quando o doc ganhou codificação submetida", () => {
      const violations = draftBackedComparisonViolations(
        input({ exceptions: new Map([["cmp-submetido", "NT-2-SP"]]) }),
      );
      expect(violations.map((v) => v.key)).toEqual(["cmp-rascunho", "cmp-submetido"]);
      expect(violations[1].detail).toBe(
        "exceção obsoleta (NT-2-SP): o doc doc-submetido já tem codificação humana submetida; remover a entrada da lista de exceções",
      );
    });

    it("quando a atribuição foi apagada", () => {
      const violations = draftBackedComparisonViolations(
        input({ exceptions: new Map([["cmp-apagada", "NT-3-SP"]]) }),
      );
      expect(violations.at(-1)).toEqual({
        key: "cmp-apagada",
        detail:
          "exceção obsoleta (NT-3-SP): a atribuição de comparação não existe mais; remover a entrada da lista de exceções",
      });
    });

    it("quando o doc foi excluído", () => {
      const violations = draftBackedComparisonViolations(
        input({
          activeDocIds: new Set(["doc-submetido"]),
          exceptions: new Map([["cmp-rascunho", "NT-4-SP"]]),
        }),
      );
      expect(violations).toEqual([
        {
          key: "cmp-rascunho",
          detail:
            "exceção obsoleta (NT-4-SP): o doc doc-rascunho foi excluído; remover a entrada da lista de exceções",
        },
      ]);
    });

    it("quando o doc perdeu o rascunho sem ganhar submissão", () => {
      const violations = draftBackedComparisonViolations(
        input({ humanLatest: [], exceptions: new Map([["cmp-rascunho", "NT-5-SP"]]) }),
      );
      expect(violations).toEqual([
        {
          key: "cmp-rascunho",
          detail:
            "exceção obsoleta (NT-5-SP): o doc doc-rascunho não tem mais codificação humana em rascunho; remover a entrada da lista de exceções",
        },
      ]);
    });
  });
});
