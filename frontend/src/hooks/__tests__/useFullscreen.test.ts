// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFullscreen } from "@/hooks/useFullscreen";

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));
  });

afterEach(() => {
  vi.useRealTimers();
});

// `exitedAt` é o instante em que o que o fullscreen escondia (a oferta do
// rascunho) volta à tela; a faixa mede a idade dali. Só uma saída de verdade
// o move: o Esc fora do fullscreen fecha select e diálogo o tempo todo.
describe("useFullscreen — instante da saída", () => {
  it("Esc fora do fullscreen não mexe em exitedAt", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const { result } = renderHook(() => useFullscreen());
    press("Escape");
    expect(result.current).toMatchObject({ isFullscreen: false, exitedAt: 0 });
  });

  it("a saída, pelo Esc ou pelo atalho, grava o instante; o Esc seguinte não", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const { result } = renderHook(() => useFullscreen());

    act(() => result.current.toggleFullscreen());
    expect(result.current).toMatchObject({ isFullscreen: true, exitedAt: 0 });

    vi.setSystemTime(5_000);
    press("Escape");
    expect(result.current).toMatchObject({ isFullscreen: false, exitedAt: 5_000 });

    vi.setSystemTime(9_000);
    press("Escape");
    expect(result.current.exitedAt).toBe(5_000);

    press("F", { ctrlKey: true, shiftKey: true });
    vi.setSystemTime(12_000);
    press("F", { ctrlKey: true, shiftKey: true });
    expect(result.current).toMatchObject({ isFullscreen: false, exitedAt: 12_000 });
  });
});
