import { describe, expect, it } from "vitest";
import { planAssignmentCycle } from "@/lib/assignment-cycle";

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
