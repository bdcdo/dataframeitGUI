import { describe, it, expect } from "vitest";
import {
  comparableMultiOptions,
  multiSelectionSets,
  multiSelectionsAgree,
} from "@/lib/compare-multi-options";

describe("multiSelectionSets", () => {
  it("converte arrays em conjuntos e ignora não-strings", () => {
    const [a, b] = multiSelectionSets([["x", 1, "y"], ["x"]]);
    expect([...a]).toEqual(["x", "y"]);
    expect([...b]).toEqual(["x"]);
  });

  it("valor ausente ou não-array vira conjunto vazio (não marcou nada)", () => {
    const sets = multiSelectionSets([undefined, null, "x"]);
    expect(sets.every((s) => s.size === 0)).toBe(true);
  });
});

describe("comparableMultiOptions", () => {
  it("mantém a ordem do schema e acrescenta as fora do schema no fim", () => {
    // A ordem importa: as opções do schema conservam a posição, e portanto o
    // atalho numérico da UI não muda quando surge uma opção stale.
    expect(
      comparableMultiOptions(["x", "y"], multiSelectionSets([["z", "x"], ["w"]])),
    ).toEqual(["x", "y", "z", "w"]);
  });

  it("não duplica opção já presente no schema", () => {
    expect(comparableMultiOptions(["x"], multiSelectionSets([["x"], ["x"]]))).toEqual(["x"]);
  });

  it("sem respostas, são as opções do schema", () => {
    expect(comparableMultiOptions(["x", "y"], [])).toEqual(["x", "y"]);
  });

  // A UI usa a opção como `key` de lista: schema com opção repetida geraria
  // duas linhas com a mesma key.
  it("dedupa opção repetida no próprio schema, mantendo a 1ª posição", () => {
    expect(comparableMultiOptions(["x", "y", "x"], [])).toEqual(["x", "y"]);
  });
});

describe("multiSelectionsAgree", () => {
  it("mesmo conjunto em ordem diferente concorda", () => {
    expect(multiSelectionsAgree(["x", "y"], multiSelectionSets([["x", "y"], ["y", "x"]]))).toBe(
      true,
    );
  });

  it("seleções diferentes divergem", () => {
    expect(multiSelectionsAgree(["x", "y"], multiSelectionSets([["x", "y"], ["x"]]))).toBe(false);
  });

  // O caminho que a união existe para cobrir e que não tinha teste em lugar
  // nenhum: a opção saiu do schema mas alguém ainda a tem marcada.
  it("opção fora do schema atual ainda diverge (#484)", () => {
    expect(multiSelectionsAgree(["x"], multiSelectionSets([["x", "z"], ["x"]]))).toBe(false);
  });

  it("opção fora do schema marcada por TODOS concorda", () => {
    expect(multiSelectionsAgree(["x"], multiSelectionSets([["x", "z"], ["x", "z"]]))).toBe(true);
  });

  it("sem respostas, concorda vacuamente — o mínimo é dos chamadores", () => {
    expect(multiSelectionsAgree(["x"], [])).toBe(true);
  });
});
