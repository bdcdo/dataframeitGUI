// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useAutoReviewKeyboard } from "../useAutoReviewKeyboard";

function fireKey(key: string, targetTag: "BODY" | "INPUT" | "TEXTAREA" = "BODY") {
  const event = new KeyboardEvent("keydown", { key, bubbles: true });
  if (targetTag === "BODY") {
    window.dispatchEvent(event);
    return;
  }
  const el = document.createElement(targetTag.toLowerCase());
  document.body.appendChild(el);
  el.dispatchEvent(event);
  document.body.removeChild(el);
}

const baseArgs = {
  fieldIndex: 1,
  totalFields: 3,
  answered: [false, false, false],
  onChoose: vi.fn(),
  onFieldNavigate: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useAutoReviewKeyboard", () => {
  it("teclas 1-4 chamam onChoose com o verdict certo", () => {
    const onChoose = vi.fn();
    renderHook(() =>
      useAutoReviewKeyboard({ ...baseArgs, readOnly: false, onChoose }),
    );

    act(() => fireKey("1"));
    act(() => fireKey("2"));
    act(() => fireKey("3"));
    act(() => fireKey("4"));

    expect(onChoose.mock.calls.map((c) => c[0])).toEqual([
      "contesta_llm",
      "admite_erro",
      "equivalente",
      "ambiguo",
    ]);
  });

  it("p/n navegam respeitando os limites", () => {
    const onFieldNavigate = vi.fn();
    renderHook(() =>
      useAutoReviewKeyboard({
        ...baseArgs,
        readOnly: false,
        fieldIndex: 0,
        onFieldNavigate,
      }),
    );

    act(() => fireKey("p"));
    expect(onFieldNavigate).not.toHaveBeenCalled();

    act(() => fireKey("n"));
    expect(onFieldNavigate).toHaveBeenCalledWith(1);
  });

  it("ignora eventos disparados a partir de INPUT/TEXTAREA", () => {
    const onChoose = vi.fn();
    renderHook(() =>
      useAutoReviewKeyboard({ ...baseArgs, readOnly: false, onChoose }),
    );

    act(() => fireKey("1", "INPUT"));
    act(() => fireKey("2", "TEXTAREA"));

    expect(onChoose).not.toHaveBeenCalled();
  });

  it("readOnly não registra o listener", () => {
    const onChoose = vi.fn();
    renderHook(() =>
      useAutoReviewKeyboard({ ...baseArgs, readOnly: true, onChoose }),
    );

    act(() => fireKey("1"));
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("handleChoose auto-avança em 250ms para o próximo campo não respondido", () => {
    const onFieldNavigate = vi.fn();
    const { result } = renderHook(() =>
      useAutoReviewKeyboard({
        ...baseArgs,
        readOnly: false,
        fieldIndex: 0,
        answered: [false, false, true],
        onFieldNavigate,
      }),
    );

    act(() => result.current.handleChoose("admite_erro"));
    expect(onFieldNavigate).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(250); });
    expect(onFieldNavigate).toHaveBeenCalledWith(1);
  });

  it("não auto-avança para verdicts que exigem justificativa", () => {
    const onFieldNavigate = vi.fn();
    const { result } = renderHook(() =>
      useAutoReviewKeyboard({
        ...baseArgs,
        readOnly: false,
        fieldIndex: 0,
        onFieldNavigate,
      }),
    );

    act(() => result.current.handleChoose("contesta_llm"));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onFieldNavigate).not.toHaveBeenCalled();
  });

  it("re-escolha cancela o timeout de auto-advance pendente", () => {
    const onFieldNavigate = vi.fn();
    const { result } = renderHook(() =>
      useAutoReviewKeyboard({
        ...baseArgs,
        readOnly: false,
        fieldIndex: 0,
        answered: [false, false, false],
        onFieldNavigate,
      }),
    );

    act(() => result.current.handleChoose("admite_erro"));
    act(() => { vi.advanceTimersByTime(100); });
    act(() => result.current.handleChoose("equivalente"));
    act(() => { vi.advanceTimersByTime(250); });

    // apenas um agendamento dispara (o da segunda escolha)
    expect(onFieldNavigate).toHaveBeenCalledTimes(1);
  });
});
