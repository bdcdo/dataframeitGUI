// @vitest-environment jsdom
//
// Ciclo do veredito extraído de `ComparePage` (#564): rascunho, confirmação,
// descarte e salvamento single-flight. A suíte do componente cobre os mesmos
// fluxos pela árvore montada; aqui cada guard fica fixado isoladamente.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCompareVerdictFlow } from "../useCompareVerdictFlow";
import type { PendingVerdict, VerdictOrigin } from "../compare-types";

const { toastInfo, toastError } = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { info: toastInfo, error: toastError } }));

const ORIGIN: VerdictOrigin = { documentId: "d1", fieldName: "q1" };
const OTHER: VerdictOrigin = { documentId: "d1", fieldName: "q2" };

function pending(
  origin: VerdictOrigin = ORIGIN,
  verdict = "sim",
): PendingVerdict {
  return { kind: "response", verdict, chosenResponseId: "r1", origin };
}

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Props = {
  ctxKey: string | null;
  currentOrigin: VerdictOrigin | null;
  handleVerdict: (
    origin: VerdictOrigin,
    verdict: string,
    chosenResponseId?: string,
  ) => Promise<boolean>;
};

function setup(handleVerdict: Props["handleVerdict"]) {
  return renderHook((props: Props) => useCompareVerdictFlow(props), {
    initialProps: { ctxKey: "d1|q1|false", currentOrigin: ORIGIN, handleVerdict },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useCompareVerdictFlow", () => {
  it("trocar de contexto descarta o rascunho no mesmo render (#430)", () => {
    const { result, rerender } = setup(vi.fn());
    act(() => result.current.preparePendingVerdict(pending()));
    expect(result.current.pendingVerdict).toEqual(pending());

    rerender({ ctxKey: "d1|q2|false", currentOrigin: OTHER, handleVerdict: vi.fn() });
    expect(result.current.pendingVerdict).toBeNull();
  });

  it("recusa rascunho de outro campo, com aviso (#613)", () => {
    const { result } = setup(vi.fn());
    act(() => result.current.preparePendingVerdict(pending(OTHER)));
    expect(result.current.pendingVerdict).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("confirmar grava na origem do rascunho e limpa quando salvou", async () => {
    const handleVerdict = vi.fn().mockResolvedValue(true);
    const { result } = setup(handleVerdict);
    act(() => result.current.preparePendingVerdict(pending()));
    await act(async () => result.current.handleConfirmPending());
    expect(handleVerdict).toHaveBeenCalledWith(ORIGIN, "sim", "r1");
    expect(result.current.pendingVerdict).toBeNull();
  });

  it("falha ao salvar mantém o rascunho para reconfirmar", async () => {
    const { result } = setup(vi.fn().mockResolvedValue(false));
    act(() => result.current.preparePendingVerdict(pending()));
    await act(async () => result.current.handleConfirmPending());
    expect(result.current.pendingVerdict).toEqual(pending());
    expect(result.current.isSavingVerdict).toBe(false);
  });

  it("single-flight: um segundo salvamento em andamento não chega a gravar", async () => {
    const save = deferred();
    const handleVerdict = vi.fn().mockReturnValue(save.promise);
    const { result } = setup(handleVerdict);

    act(() => result.current.submitCurrentVerdict("ambiguo"));
    expect(result.current.isSaveInFlight()).toBe(true);
    expect(result.current.isSavingVerdict).toBe(true);
    act(() => result.current.submitCurrentVerdict("pular"));
    expect(handleVerdict).toHaveBeenCalledTimes(1);

    await act(async () => save.resolve(true));
    expect(result.current.isSaveInFlight()).toBe(false);
    expect(result.current.isSavingVerdict).toBe(false);
  });

  it("durante o salvamento, novo rascunho e descarte são ignorados", async () => {
    const save = deferred();
    const { result } = setup(vi.fn().mockReturnValue(save.promise));
    act(() => result.current.preparePendingVerdict(pending()));
    act(() => result.current.handleConfirmPending());

    act(() =>
      result.current.preparePendingVerdict(pending(ORIGIN, "não")),
    );
    expect(toastInfo).toHaveBeenCalledTimes(1);
    act(() => result.current.discardPendingVerdict());
    expect(result.current.pendingVerdict).toEqual(pending());

    await act(async () => save.resolve(false));
    act(() => result.current.discardPendingVerdict());
    expect(result.current.pendingVerdict).toBeNull();
  });

  it("sem doc/campo, a escrita direta não faz nada", () => {
    const handleVerdict = vi.fn();
    const { result } = renderHook(() =>
      useCompareVerdictFlow({ ctxKey: null, currentOrigin: null, handleVerdict }),
    );
    act(() => result.current.submitCurrentVerdict("ambiguo"));
    expect(handleVerdict).not.toHaveBeenCalled();
  });
});
