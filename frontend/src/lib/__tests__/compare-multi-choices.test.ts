import { describe, it, expect } from "vitest";
import { computeInitialChoices } from "@/lib/compare-multi-choices";

// Helper para montar optionStats com os campos que `computeInitialChoices` lê.
function stat(option: string, selectedCount: number, totalRespondents: number) {
  return { option, selectedCount, totalRespondents };
}

describe("computeInitialChoices — pré-preenchimento (verdict vs. maioria)", () => {
  it("verdict JSON existente tem precedência sobre a maioria", () => {
    // A maioria diria { A: false, B: true }; o verdict salvo é o oposto.
    const stats = [stat("A", 0, 3), stat("B", 3, 3)];
    expect(computeInitialChoices('{"A":true,"B":false}', stats)).toEqual({
      A: true,
      B: false,
    });
  });

  it("sem verdict, segue a maioria estrita (selectedCount > total/2)", () => {
    const stats = [stat("A", 2, 3), stat("B", 1, 3)];
    expect(computeInitialChoices(undefined, stats)).toEqual({
      A: true,
      B: false,
    });
  });

  it("empate não marca a opção (maioria é estrita, não >=)", () => {
    // 1 de 2 e 2 de 4 são empates: ambos ficam false.
    const stats = [stat("A", 1, 2), stat("B", 2, 4)];
    expect(computeInitialChoices(undefined, stats)).toEqual({
      A: false,
      B: false,
    });
  });

  it("verdict legado (string) ou JSON malformado é ignorado e cai na maioria", () => {
    const stats = [stat("A", 3, 3)]; // maioria → true
    expect(computeInitialChoices("Deferido", stats)).toEqual({ A: true });
    expect(computeInitialChoices("{invalido", stats)).toEqual({ A: true });
  });

  it("verdict ausente com optionStats vazio retorna objeto vazio sem lançar", () => {
    expect(computeInitialChoices(undefined, [])).toEqual({});
  });
});
