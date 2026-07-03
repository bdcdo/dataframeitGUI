// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";

import { useStableDocOrder } from "@/components/compare/useStableDocOrder";
import type { CompareDocument } from "@/components/compare/compare-types";
import { doc } from "./compare-test-helpers";

const ids = (docs: CompareDocument[]) => docs.map((d) => d.id);

type OrderHookProps = { documents: CompareDocument[]; resetKey?: boolean };

function renderOrder(documents: CompareDocument[], resetKey = false) {
  return renderHook(
    (props: OrderHookProps) =>
      useStableDocOrder(props.documents, props.resetKey ?? false),
    { initialProps: { documents, resetKey } as OrderHookProps },
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

  // Regressão: alternar a fila de Comparação entre "Meus atribuídos" e
  // "Todos" (mesmo componente, sem remount) não pode deixar os docs da fila
  // pessoal presos no topo da fila "Todos", fora da ordem de prioridade do
  // servidor — resetKey trata essa troca como composição totalmente nova.
  it("resetKey muda: ordem nasce do zero, mesmo com docs sobrepostos", () => {
    const [A, B, C] = [doc("A"), doc("B"), doc("C")];
    const { result, rerender } = renderOrder([A, B, C], false);

    // Servidor devolve os ~500 docs do projeto (aqui simulados por D, E),
    // com A-C espalhados fora do topo — a troca de resetKey (mesma composição
    // OU não) não deve preservar a ordem antiga.
    rerender({ documents: [doc("D"), A, doc("E"), C, B], resetKey: true });

    expect(ids(result.current)).toEqual(["D", "A", "E", "C", "B"]);
  });

  it("resetKey igual: comportamento normal de composição é preservado", () => {
    const [A, B, C] = [doc("A"), doc("B"), doc("C")];
    const { result, rerender } = renderOrder([A, B, C], true);

    // Mesmo resetKey, servidor reordenou (revalidate) — não deve remexer.
    rerender({ documents: [C, A, B], resetKey: true });
    expect(ids(result.current)).toEqual(["A", "B", "C"]);
  });
});
