import { describe, expect, it } from "vitest";
import {
  decideSelfComparison,
  planAssignmentCycle,
  SELF_COMPARISON_NOT_CODER_MESSAGE,
  SELF_COMPARISON_STALE_MESSAGE,
  type CycleStep,
} from "@/lib/assignment-cycle";

const row = (id: string, type: string, status = "pendente") => ({ id, type, status });

describe("planAssignmentCycle", () => {
  it("vazio → codificação → comparação → vazio", () => {
    expect(planAssignmentCycle([])).toEqual({ kind: "insertCoding" });
    expect(planAssignmentCycle([row("c", "codificacao")])).toEqual({ kind: "promote", codingId: "c" });
    expect(planAssignmentCycle([row("r", "comparacao")])).toEqual({ kind: "delete", ids: ["r"] });
    expect(planAssignmentCycle([row("c", "codificacao"), row("r", "comparacao")])).toEqual({
      kind: "delete",
      ids: ["c", "r"],
    });
  });

  it("codificação concluída sem comparação abre a autocomparação; o resto não pendente trava", () => {
    expect(planAssignmentCycle([row("c", "codificacao", "concluido")])).toEqual({
      kind: "selfComparisonBesideDone",
    });
    expect(planAssignmentCycle([row("c", "codificacao", "em_andamento")])).toEqual({ kind: "none" });
    expect(
      planAssignmentCycle([row("c", "codificacao", "concluido"), row("r", "comparacao", "pendente")]),
    ).toEqual({ kind: "none" });
    expect(planAssignmentCycle([row("r", "comparacao", "concluido")])).toEqual({ kind: "none" });
  });
});

describe("decideSelfComparison", () => {
  const promote: CycleStep = { kind: "promote", codingId: "c" };
  const beside: CycleStep = { kind: "selfComparisonBesideDone" };
  const del: CycleStep = { kind: "delete", ids: ["r"] };

  it("sem confirmação: pede para quem codificou, aplica para os demais", () => {
    expect(decideSelfComparison(promote, true, false)).toEqual({ outcome: "confirm" });
    expect(decideSelfComparison(beside, true, false)).toEqual({ outcome: "confirm" });
    expect(decideSelfComparison(promote, false, false)).toEqual({ outcome: "apply", step: promote, approve: false });
    expect(decideSelfComparison(del, true, false)).toEqual({ outcome: "apply", step: del, approve: false });
    expect(decideSelfComparison(beside, false, false)).toEqual({
      outcome: "rejected",
      error: SELF_COMPARISON_NOT_CODER_MESSAGE,
    });
  });

  it("com confirmação: só aplica o passo que dá a comparação a quem codificou", () => {
    expect(decideSelfComparison(promote, true, true)).toEqual({ outcome: "apply", step: promote, approve: true });
    expect(decideSelfComparison(beside, true, true)).toEqual({ outcome: "apply", step: beside, approve: true });
    const stale: [CycleStep, boolean][] = [[del, true], [promote, false], [beside, false]];
    for (const [step, coder] of stale) {
      expect(decideSelfComparison(step, coder, true)).toEqual({
        outcome: "rejected",
        error: SELF_COMPARISON_STALE_MESSAGE,
      });
    }
  });
});
