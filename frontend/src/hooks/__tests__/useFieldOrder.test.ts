// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";

const getOrder = vi.fn();
const saveOrder = vi.fn();
const toastError = vi.fn();

vi.mock("@/actions/field-order", () => ({
  getResearcherFieldOrder: (...a: unknown[]) => getOrder(...a),
  saveResearcherFieldOrder: (...a: unknown[]) => saveOrder(...a),
}));
vi.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a) },
}));

import { useFieldOrder } from "../useFieldOrder";

beforeEach(() => {
  getOrder.mockReset();
  saveOrder.mockReset();
  toastError.mockReset();
  saveOrder.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe("useFieldOrder", () => {
  it("carrega a ordem do banco", async () => {
    getOrder.mockResolvedValue({ order: ["a", "b"] });
    const { result } = renderHook(() => useFieldOrder("p1"));
    await waitFor(() => expect(result.current.fieldOrder).toEqual(["a", "b"]));
    expect(getOrder).toHaveBeenCalledWith("p1");
  });

  it("drag antes do load descarta o valor do banco (guard anti-corrida)", async () => {
    let resolveLoad: (v: { order: string[] | null }) => void = () => {};
    getOrder.mockReturnValue(
      new Promise<{ order: string[] | null }>((r) => {
        resolveLoad = r;
      }),
    );
    const { result } = renderHook(() => useFieldOrder("p1"));

    act(() => result.current.handleReorder(["b", "a"]));
    await act(async () => {
      resolveLoad({ order: ["a", "b"] });
    });

    expect(result.current.fieldOrder).toEqual(["b", "a"]);
  });

  it("coalesce múltiplos reorders num único save", async () => {
    vi.useFakeTimers();
    getOrder.mockReturnValue(new Promise<{ order: string[] | null }>(() => {}));
    try {
      const { result } = renderHook(() => useFieldOrder("p1"));
      act(() => result.current.handleReorder(["x"]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      act(() => result.current.handleReorder(["y"]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(saveOrder).toHaveBeenCalledTimes(1);
      expect(saveOrder).toHaveBeenCalledWith("p1", ["y"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush no unmount salva a ordem pendente antes dos 500ms", () => {
    vi.useFakeTimers();
    getOrder.mockReturnValue(new Promise<{ order: string[] | null }>(() => {}));
    try {
      const { result, unmount } = renderHook(() => useFieldOrder("p1"));
      act(() => result.current.handleReorder(["x"]));
      unmount();

      expect(saveOrder).toHaveBeenCalledTimes(1);
      expect(saveOrder).toHaveBeenCalledWith("p1", ["x"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mostra toast de erro quando o save falha", async () => {
    getOrder.mockReturnValue(new Promise<{ order: string[] | null }>(() => {}));
    saveOrder.mockResolvedValue({ success: false, error: "boom" });
    const { result } = renderHook(() => useFieldOrder("p1"));

    act(() => result.current.handleReorder(["x"]));
    act(() => result.current.flushOrderSave());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
