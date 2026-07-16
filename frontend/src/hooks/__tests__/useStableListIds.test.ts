// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useStableListIds } from "../useStableListIds";

afterEach(cleanup);

describe("useStableListIds", () => {
  it("gera um id estável por posição no primeiro render", () => {
    const { result } = renderHook(({ n }) => useStableListIds(n), {
      initialProps: { n: 3 },
    });
    expect(result.current.ids).toHaveLength(3);
    // ids únicos
    expect(new Set(result.current.ids).size).toBe(3);
  });

  it("preserva ids ao re-renderizar com o mesmo length", () => {
    const { result, rerender } = renderHook(({ n }) => useStableListIds(n), {
      initialProps: { n: 2 },
    });
    const before = [...result.current.ids];
    rerender({ n: 2 });
    expect(result.current.ids).toEqual(before);
  });

  it("appendId mais re-render com length+1 mantém o prefixo e cria id novo no fim", () => {
    const { result, rerender } = renderHook(({ n }) => useStableListIds(n), {
      initialProps: { n: 2 },
    });
    const before = [...result.current.ids];
    // Simula o fluxo do caller: appendId() junto do onChange que aumenta o length.
    act(() => result.current.appendId());
    rerender({ n: 3 });
    expect(result.current.ids).toHaveLength(3);
    expect(result.current.ids.slice(0, 2)).toEqual(before);
    expect(result.current.ids[2]).not.toBe(before[0]);
    expect(result.current.ids[2]).not.toBe(before[1]);
  });

  it("removeIdAt no meio descarta o id certo (não o do fim)", () => {
    const { result, rerender } = renderHook(({ n }) => useStableListIds(n), {
      initialProps: { n: 3 },
    });
    const [id0, id1, id2] = result.current.ids;
    // Remove a posição 1 (meio da lista) — o caso crítico do no-array-index-as-key.
    act(() => result.current.removeIdAt(1));
    rerender({ n: 2 });
    // O id removido é o do meio; id0 e id2 sobrevivem e id2 desliza para 1.
    expect(result.current.ids).toEqual([id0, id2]);
    expect(result.current.ids).not.toContain(id1);
  });

  it("reconcilia mudança externa de length (sem handler) preservando o prefixo", () => {
    const { result, rerender } = renderHook(({ n }) => useStableListIds(n), {
      initialProps: { n: 1 },
    });
    const [id0] = result.current.ids;
    // Mudança externa (ex.: troca de campo) aumenta o length sem appendId().
    rerender({ n: 3 });
    expect(result.current.ids).toHaveLength(3);
    expect(result.current.ids[0]).toBe(id0);
    expect(new Set(result.current.ids).size).toBe(3);
  });

  it("reconcilia encolhimento externo truncando do fim", () => {
    const { result, rerender } = renderHook(({ n }) => useStableListIds(n), {
      initialProps: { n: 3 },
    });
    const [id0, id1] = result.current.ids;
    rerender({ n: 2 });
    expect(result.current.ids).toEqual([id0, id1]);
  });

  it("appendId devolve o id criado", () => {
    const { result, rerender } = renderHook(({ n }) => useStableListIds(n), {
      initialProps: { n: 1 },
    });
    let devolvido = "";
    act(() => {
      devolvido = result.current.appendId();
    });
    rerender({ n: 2 });
    // O caller precisa do id de forma síncrona para apontar seleção/expansão
    // para a linha nova no mesmo handler que a cria.
    expect(devolvido).not.toBe("");
    expect(result.current.ids[1]).toBe(devolvido);
  });

  describe("moveId", () => {
    it("o id viaja com o item, não fica na posição", () => {
      const { result, rerender } = renderHook(({ n }) => useStableListIds(n), {
        initialProps: { n: 3 },
      });
      const [id0, id1, id2] = result.current.ids;
      act(() => result.current.moveId(0, 2));
      rerender({ n: 3 });
      expect(result.current.ids).toEqual([id1, id2, id0]);
    });

    it("mover para trás também preserva o conjunto", () => {
      const { result, rerender } = renderHook(({ n }) => useStableListIds(n), {
        initialProps: { n: 3 },
      });
      const [id0, id1, id2] = result.current.ids;
      act(() => result.current.moveId(2, 0));
      rerender({ n: 3 });
      expect(result.current.ids).toEqual([id2, id0, id1]);
    });

    it("um move não perde nem duplica id", () => {
      const { result, rerender } = renderHook(({ n }) => useStableListIds(n), {
        initialProps: { n: 4 },
      });
      const antes = [...result.current.ids];
      act(() => result.current.moveId(1, 3));
      rerender({ n: 4 });
      expect([...result.current.ids].sort()).toEqual([...antes].sort());
    });

    it("índice fora de faixa não embaralha a lista", () => {
      const { result, rerender } = renderHook(({ n }) => useStableListIds(n), {
        initialProps: { n: 2 },
      });
      const antes = [...result.current.ids];
      // O reconcile é keyed em `length`, que um move não muda: um id perdido
      // aqui não seria refeito por ele.
      act(() => result.current.moveId(0, 5));
      act(() => result.current.moveId(-1, 1));
      rerender({ n: 2 });
      expect(result.current.ids).toEqual(antes);
    });
  });
});
