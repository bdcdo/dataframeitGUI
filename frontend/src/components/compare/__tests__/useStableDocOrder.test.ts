// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";

import { useStableDocOrder } from "@/components/compare/useStableDocOrder";
import type { CompareDocument } from "@/components/compare/compare-types";
import { doc } from "./compare-test-helpers";

const ids = (docs: CompareDocument[]) => docs.map((d) => d.id);

function renderOrder(documents: CompareDocument[]) {
  return renderHook(
    (props: { documents: CompareDocument[] }) =>
      useStableDocOrder(props.documents),
    { initialProps: { documents } },
  );
}

afterEach(cleanup);

describe("useStableDocOrder — ordem estável da fila", () => {
  it("re-sort do servidor não remexe a fila", () => {
    const [A, B, C] = [doc("A"), doc("B"), doc("C")];
    const { result, rerender } = renderOrder([A, B, C]);

    // Simula o revalidate pós-veredito: o sort por pendências reordenou.
    rerender({ documents: [C, A, B] });

    expect(ids(result.current)).toEqual(["A", "B", "C"]);
  });

  it("re-sort entrega os OBJETOS novos do servidor, na ordem congelada", () => {
    const [A, B] = [doc("A"), doc("B")];
    const { result, rerender } = renderOrder([A, B]);

    const A2 = doc("A", "Doc A atualizado");
    rerender({ documents: [B, A2] });

    expect(result.current[0]).toBe(A2);
  });

  it("doc removido some preservando a ordem dos demais", () => {
    const [A, B, C] = [doc("A"), doc("B"), doc("C")];
    const { result, rerender } = renderOrder([A, B, C]);

    rerender({ documents: [C, B] });

    expect(ids(result.current)).toEqual(["B", "C"]);
  });

  it("doc novo entra ao fim, na ordem do servidor", () => {
    const [A, B, C, D] = [doc("A"), doc("B"), doc("C"), doc("D")];
    const { result, rerender } = renderOrder([A, B]);

    rerender({ documents: [D, A, C, B] });

    expect(ids(result.current)).toEqual(["A", "B", "D", "C"]);
  });

  it("ida-e-volta de filtro preserva a posição relativa dos sobreviventes", () => {
    const [A, B, C] = [doc("A"), doc("B"), doc("C")];
    const { result, rerender } = renderOrder([A, B, C]);

    // Filtro estreitou a fila (B saiu)...
    rerender({ documents: [A, C] });
    expect(ids(result.current)).toEqual(["A", "C"]);

    // ...e foi desfeito: A e C mantêm a ordem; B volta ao fim.
    rerender({ documents: [B, A, C] });
    expect(ids(result.current)).toEqual(["A", "C", "B"]);
  });

  it("lista vazia na montagem adota a ordem do servidor quando popular", () => {
    const [A, B] = [doc("A"), doc("B")];
    const { result, rerender } = renderOrder([]);

    expect(result.current).toEqual([]);

    rerender({ documents: [B, A] });
    expect(ids(result.current)).toEqual(["B", "A"]);
  });
});
