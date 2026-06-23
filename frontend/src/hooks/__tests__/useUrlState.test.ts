// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const replace = vi.fn();
const push = vi.fn();
let currentParams = "doc=d0";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(currentParams),
  usePathname: () => "/x",
  useRouter: () => ({ replace, push }),
}));

import { useUrlState, useDocParam } from "../useUrlState";

beforeEach(() => {
  replace.mockClear();
  push.mockClear();
  currentParams = "doc=d0";
});
afterEach(cleanup);

describe("useUrlState", () => {
  it("get lê o param atual", () => {
    const { result } = renderHook(() => useUrlState());
    expect(result.current.get("doc")).toBe("d0");
    expect(result.current.get("ausente")).toBeNull();
  });

  it("set usa replace com { scroll: false }", () => {
    const { result } = renderHook(() => useUrlState());
    act(() => result.current.set({ doc: "d1" }, { scroll: false }));
    expect(replace).toHaveBeenCalledWith("/x?doc=d1", { scroll: false });
  });

  it("set com null remove o param", () => {
    const { result } = renderHook(() => useUrlState());
    act(() => result.current.set({ doc: null }, { scroll: false }));
    expect(replace).toHaveBeenCalledWith("/x", { scroll: false });
  });

  it("set escreve múltiplos params num único navigate", () => {
    const { result } = renderHook(() => useUrlState());
    act(() => result.current.set({ sort: "default", doc: "d2" }, { scroll: false }));
    expect(replace).toHaveBeenCalledTimes(1);
    const url = replace.mock.calls[0][0] as string;
    expect(url).toContain("sort=default");
    expect(url).toContain("doc=d2");
  });

  it("method push sem scroll → chamado sem 2º argumento", () => {
    const { result } = renderHook(() => useUrlState());
    act(() => result.current.set({ viewAsUser: "u1" }, { method: "push" }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0].length).toBe(1);
    expect(push.mock.calls[0][0]).toBe("/x?doc=d0&viewAsUser=u1");
    expect(replace).not.toHaveBeenCalled();
  });

  it("qs vazio → URL sem '?'", () => {
    currentParams = "";
    const { result } = renderHook(() => useUrlState());
    act(() => result.current.set({ doc: null }));
    expect(replace).toHaveBeenCalledWith("/x");
  });
});

describe("useDocParam", () => {
  it("lê doc e seta com replace + scroll:false", () => {
    const { result } = renderHook(() => useDocParam());
    expect(result.current[0]).toBe("d0");
    act(() => result.current[1]("d9"));
    expect(replace).toHaveBeenCalledWith("/x?doc=d9", { scroll: false });
  });

  it("setar null remove o doc", () => {
    const { result } = renderHook(() => useDocParam());
    act(() => result.current[1](null));
    expect(replace).toHaveBeenCalledWith("/x", { scroll: false });
  });
});
