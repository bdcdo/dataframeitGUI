// @vitest-environment jsdom
//
// A API fica pausada no Fly quando ninguém a usa. O aquecimento é o que faz a
// retomada acontecer quando alguém abre a GUI, e não no clique em "Executar";
// a regra que importa fixar é que só aba visível pinga, para que uma aba
// esquecida em segundo plano não segure a máquina ligada.
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_WARMUP_INTERVAL_MS, useApiWarmup } from "../useApiWarmup";

let visibility: DocumentVisibilityState = "visible";
const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}")));

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function healthCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/health")).length;
}

describe("useApiWarmup", () => {
  it("acorda a API ao montar com a aba visível", () => {
    renderHook(() => useApiWarmup());
    expect(healthCalls()).toBe(1);
  });

  it("não pinga ao montar com a aba escondida", () => {
    visibility = "hidden";
    renderHook(() => useApiWarmup());
    expect(healthCalls()).toBe(0);
  });

  it("repete no intervalo só enquanto a aba está visível", () => {
    renderHook(() => useApiWarmup());
    vi.advanceTimersByTime(API_WARMUP_INTERVAL_MS);
    expect(healthCalls()).toBe(2);

    visibility = "hidden";
    vi.advanceTimersByTime(API_WARMUP_INTERVAL_MS * 3);
    expect(healthCalls()).toBe(2);
  });

  it("acorda de novo quando a aba volta a ficar visível", () => {
    visibility = "hidden";
    renderHook(() => useApiWarmup());
    setVisibility("visible");
    expect(healthCalls()).toBe(1);
  });

  it("para de pingar depois de desmontar", () => {
    const { unmount } = renderHook(() => useApiWarmup());
    unmount();
    vi.advanceTimersByTime(API_WARMUP_INTERVAL_MS * 2);
    setVisibility("visible");
    expect(healthCalls()).toBe(1);
  });

  it("engole a falha de rede sem rejeição solta", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("offline")));
    renderHook(() => useApiWarmup());
    await vi.runOnlyPendingTimersAsync();
    expect(healthCalls()).toBe(2);
  });
});
