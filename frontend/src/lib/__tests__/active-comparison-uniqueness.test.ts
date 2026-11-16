import { describe, expect, it } from "vitest";
import {
  activeComparisonUniquenessViolations,
  type ComparisonAssignmentRow,
} from "@/lib/active-comparison-uniqueness";

function comparison(
  overrides: Partial<ComparisonAssignmentRow> & Pick<ComparisonAssignmentRow, "id">,
): ComparisonAssignmentRow {
  return { document_id: "doc", round_id: "rodada-2", status: "pendente", ...overrides };
}

// Chave de assignments_one_active_comparacao_per_doc_round (20260731120000):
// (document_id, round_id) WHERE type = 'comparacao'
// AND status IS DISTINCT FROM 'concluido'.
describe("activeComparisonUniquenessViolations", () => {
  it("acusa duas comparações ativas no mesmo doc e rodada", () => {
    expect(
      activeComparisonUniquenessViolations([
        comparison({ id: "c-1" }),
        comparison({ id: "c-2", status: "em_andamento" }),
      ]),
    ).toEqual([{ key: "doc|rodada-2", detail: "2 comparações ativas: c-1, c-2" }]);
  });

  // O falso positivo que a invariante dava ao agrupar só por document_id, a
  // chave do índice anterior a 20260731120000.
  it("não acusa comparações ativas do mesmo doc em rodadas diferentes", () => {
    expect(
      activeComparisonUniquenessViolations([
        comparison({ id: "c-velha", round_id: "rodada-1" }),
        comparison({ id: "c-nova" }),
      ]),
    ).toEqual([]);
  });

  it("conta status NULL como ativo, como o IS DISTINCT FROM do índice", () => {
    expect(
      activeComparisonUniquenessViolations([
        comparison({ id: "c-null", status: null }),
        comparison({ id: "c-pendente" }),
      ]).map((v) => v.detail),
    ).toEqual(["2 comparações ativas: c-null, c-pendente"]);
  });

  it("deixa de fora a comparação concluída", () => {
    expect(
      activeComparisonUniquenessViolations([
        comparison({ id: "c-concluida", status: "concluido" }),
        comparison({ id: "c-concluida-2", status: "concluido" }),
        comparison({ id: "c-ativa" }),
      ]),
    ).toEqual([]);
  });

  it("não agrupa comparações sem documento, como o índice (NULLS DISTINCT)", () => {
    expect(
      activeComparisonUniquenessViolations([
        comparison({ id: "c-a", document_id: null }),
        comparison({ id: "c-b", document_id: null }),
      ]),
    ).toEqual([]);
  });
});
