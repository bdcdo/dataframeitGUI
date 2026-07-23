// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";

const toastWarning = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { warning: toastWarning } }));

import { useCompareNavGuard } from "@/components/compare/useCompareNavGuard";
import type { PendingVerdict } from "@/components/compare/compare-types";

afterEach(cleanup);
beforeEach(() => toastWarning.mockClear());

const pending: PendingVerdict = { kind: "custom", verdict: "v" };

function render(
  over: Partial<Parameters<typeof useCompareNavGuard>[0]> = {},
) {
  const handlers = {
    handleDocNavigate: vi.fn(),
    setFieldIndex: vi.fn(),
    handleNextDoc: vi.fn(),
    goNextField: vi.fn(),
    goPrevField: vi.fn(),
    changeFilter: vi.fn(),
    handleQueueChange: vi.fn(),
  };
  const view = renderHook(() =>
    useCompareNavGuard({
      pendingVerdict: null,
      isSaveInFlight: () => false,
      ...handlers,
      ...over,
    }),
  );
  return { ...view, handlers };
}

describe("useCompareNavGuard — guardNavigation", () => {
  it("libera quando não há rascunho nem save em andamento", () => {
    const { result } = render();
    expect(result.current.guardNavigation()).toBe(true);
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("bloqueia com toast quando há rascunho pendente", () => {
    const { result } = render({ pendingVerdict: pending });
    expect(result.current.guardNavigation()).toBe(false);
    expect(toastWarning).toHaveBeenCalledTimes(1);
    // `id` fixo: tentativas repetidas atualizam o mesmo toast.
    expect(toastWarning).toHaveBeenCalledWith(expect.any(String), {
      id: "compare-nav-guard",
    });
  });

  it("bloqueia em silêncio (sem toast) durante o save em andamento", () => {
    const { result } = render({
      pendingVerdict: pending,
      isSaveInFlight: () => true,
    });
    expect(result.current.guardNavigation()).toBe(false);
    expect(toastWarning).not.toHaveBeenCalled();
  });
});

describe("useCompareNavGuard — wrappers", () => {
  it("chamam o callback cru quando o guard libera", () => {
    const { result, handlers } = render();
    result.current.navigateDoc(2);
    result.current.nextField();
    result.current.changeFieldFilter("multi");
    expect(handlers.handleDocNavigate).toHaveBeenCalledWith(2);
    expect(handlers.goNextField).toHaveBeenCalled();
    expect(handlers.changeFilter).toHaveBeenCalledWith("multi");
  });

  it("não chamam o callback cru quando o guard bloqueia", () => {
    const { result, handlers } = render({ pendingVerdict: pending });
    result.current.navigateDoc(2);
    result.current.nextDoc();
    result.current.changeQueue("all");
    expect(handlers.handleDocNavigate).not.toHaveBeenCalled();
    expect(handlers.handleNextDoc).not.toHaveBeenCalled();
    expect(handlers.handleQueueChange).not.toHaveBeenCalled();
  });
});
