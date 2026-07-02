// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { usePinnedDoc, pinnedDocIndex } from "../usePinnedDoc";

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(cleanup);

describe("usePinnedDoc", () => {
  it("lê o valor do sessionStorage já no primeiro render", () => {
    sessionStorage.setItem("k", "d1");
    const { result } = renderHook(() => usePinnedDoc("k"));
    // Sem effect de restore → valor disponível no render inicial.
    expect(result.current[0]).toBe("d1");
  });

  it("setter escreve no storage e atualiza o valor reativo", () => {
    const { result } = renderHook(() => usePinnedDoc("k"));
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]("d2"));
    expect(sessionStorage.getItem("k")).toBe("d2");
    expect(result.current[0]).toBe("d2");
  });

  it("setter null remove do storage", () => {
    sessionStorage.setItem("k", "d1");
    const { result } = renderHook(() => usePinnedDoc("k"));
    act(() => result.current[1](null));
    expect(sessionStorage.getItem("k")).toBeNull();
    expect(result.current[0]).toBeNull();
  });

  it("limpa órfão quando o id fixado não está em validIds", async () => {
    sessionStorage.setItem("k", "d1");
    const { result } = renderHook(() =>
      usePinnedDoc("k", { validIds: ["d2", "d3"] }),
    );
    await waitFor(() => expect(result.current[0]).toBeNull());
    expect(sessionStorage.getItem("k")).toBeNull();
  });

  it("mantém o valor quando o id fixado está em validIds", () => {
    sessionStorage.setItem("k", "d2");
    const { result } = renderHook(() =>
      usePinnedDoc("k", { validIds: ["d2", "d3"] }),
    );
    expect(result.current[0]).toBe("d2");
    expect(sessionStorage.getItem("k")).toBe("d2");
  });

  it("troca de storageKey re-lê o valor", () => {
    sessionStorage.setItem("a", "da");
    sessionStorage.setItem("b", "db");
    const { result, rerender } = renderHook(({ k }) => usePinnedDoc(k), {
      initialProps: { k: "a" },
    });
    expect(result.current[0]).toBe("da");
    rerender({ k: "b" });
    expect(result.current[0]).toBe("db");
  });

  it("propaga a mudança entre instâncias com a mesma chave", () => {
    const a = renderHook(() => usePinnedDoc("shared"));
    const b = renderHook(() => usePinnedDoc("shared"));
    act(() => a.result.current[1]("dx"));
    expect(a.result.current[0]).toBe("dx");
    expect(b.result.current[0]).toBe("dx");
  });
});

describe("pinnedDocIndex", () => {
  it("retorna o índice do id fixado quando presente", () => {
    expect(pinnedDocIndex(["a", "b", "c"], "b")).toBe(1);
  });

  it("cai para 0 quando o id fixado não está na lista", () => {
    expect(pinnedDocIndex(["a", "b"], "x")).toBe(0);
  });

  it("cai para 0 com pin null", () => {
    expect(pinnedDocIndex(["a", "b"], null)).toBe(0);
  });

  it("cai para 0 com lista vazia", () => {
    expect(pinnedDocIndex([], "a")).toBe(0);
  });
});
