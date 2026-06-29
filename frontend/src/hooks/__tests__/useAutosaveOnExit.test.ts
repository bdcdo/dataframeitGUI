// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useAutosaveOnExit, type AutosavePayload } from "../useAutosaveOnExit";

const sendBeacon = vi.fn();
const fetchMock = vi.fn();

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

function fireVisibility(state: "visible" | "hidden") {
  setVisibility(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

const payload: AutosavePayload = {
  projectId: "p",
  documentId: "d",
  answers: { q1: "a" },
  notes: "n",
};

beforeEach(() => {
  sendBeacon.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "sendBeacon", {
    value: sendBeacon,
    configurable: true,
    writable: true,
  });
  vi.stubGlobal("fetch", fetchMock);
  setVisibility("visible");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useAutosaveOnExit — beforeunload", () => {
  it("previne a saída só quando há doc ativo sujo", () => {
    const { rerender } = renderHook((props) => useAutosaveOnExit(props), {
      initialProps: {
        activeDocId: "d" as string | null,
        isDirty: true,
        getPayload: () => payload,
      },
    });

    const ev1 = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev1);
    expect(ev1.defaultPrevented).toBe(true);

    rerender({ activeDocId: "d", isDirty: false, getPayload: () => payload });
    const ev2 = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);

    rerender({ activeDocId: null, isDirty: true, getPayload: () => payload });
    const ev3 = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev3);
    expect(ev3.defaultPrevented).toBe(false);
  });
});

describe("useAutosaveOnExit — visibilitychange", () => {
  it("usa sendBeacon e NÃO chama fetch quando enfileira", async () => {
    sendBeacon.mockReturnValue(true);
    renderHook(() =>
      useAutosaveOnExit({ activeDocId: "d", isDirty: true, getPayload: () => payload }),
    );

    fireVisibility("hidden");

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe("/api/autosave");
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe("application/json");
    expect(await (blob as Blob).text()).toBe(JSON.stringify(payload));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cai no fetch keepalive quando sendBeacon retorna false", () => {
    sendBeacon.mockReturnValue(false);
    renderHook(() =>
      useAutosaveOnExit({ activeDocId: "d", isDirty: true, getPayload: () => payload }),
    );

    fireVisibility("hidden");

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/autosave");
    expect(opts).toMatchObject({
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  });

  it("cai no fetch quando sendBeacon lança (fila cheia)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendBeacon.mockImplementation(() => {
      throw new Error("fila cheia");
    });
    renderHook(() =>
      useAutosaveOnExit({ activeDocId: "d", isDirty: true, getPayload: () => payload }),
    );

    fireVisibility("hidden");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("usa fetch quando sendBeacon não existe", () => {
    Object.defineProperty(navigator, "sendBeacon", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    renderHook(() =>
      useAutosaveOnExit({ activeDocId: "d", isDirty: true, getPayload: () => payload }),
    );

    fireVisibility("hidden");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("não salva quando a aba continua visível", () => {
    sendBeacon.mockReturnValue(true);
    renderHook(() =>
      useAutosaveOnExit({ activeDocId: "d", isDirty: true, getPayload: () => payload }),
    );

    fireVisibility("visible");
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("não salva quando não está sujo", () => {
    sendBeacon.mockReturnValue(true);
    renderHook(() =>
      useAutosaveOnExit({ activeDocId: "d", isDirty: false, getPayload: () => payload }),
    );

    fireVisibility("hidden");
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("não salva quando getPayload retorna null", () => {
    sendBeacon.mockReturnValue(true);
    renderHook(() =>
      useAutosaveOnExit({ activeDocId: "d", isDirty: true, getPayload: () => null }),
    );

    fireVisibility("hidden");
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("remove os listeners no unmount", () => {
    sendBeacon.mockReturnValue(true);
    const { unmount } = renderHook(() =>
      useAutosaveOnExit({ activeDocId: "d", isDirty: true, getPayload: () => payload }),
    );

    unmount();
    fireVisibility("hidden");
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("usa o payload mais recente via ref atualizado", async () => {
    sendBeacon.mockReturnValue(true);
    const { rerender } = renderHook((props) => useAutosaveOnExit(props), {
      initialProps: {
        activeDocId: "d" as string | null,
        isDirty: true,
        getPayload: () => payload,
      },
    });

    const newPayload: AutosavePayload = { ...payload, answers: { q1: "z" } };
    rerender({ activeDocId: "d", isDirty: true, getPayload: () => newPayload });

    fireVisibility("hidden");
    const blob = sendBeacon.mock.calls[0][1] as Blob;
    expect(await blob.text()).toBe(JSON.stringify(newPayload));
  });
});
