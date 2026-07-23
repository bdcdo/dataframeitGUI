// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

import { useCompareVerdictSubmission } from "@/components/compare/useCompareVerdictSubmission";
import type { PendingVerdict } from "@/components/compare/compare-types";

afterEach(cleanup);

/** Promise controlável para simular um `handleVerdict` pendurado. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function render(
  handleVerdict: (v: string, id?: string) => Promise<boolean>,
  ctxKey: string | null = "d1|campo|false",
) {
  return renderHook(
    (props: { ctxKey: string | null }) =>
      useCompareVerdictSubmission({ ctxKey: props.ctxKey, handleVerdict }),
    { initialProps: { ctxKey } },
  );
}

const pending: PendingVerdict = {
  kind: "response",
  verdict: "v",
  chosenResponseId: "r1",
};

describe("useCompareVerdictSubmission — single-flight", () => {
  it("um segundo submit durante o in-flight é rejeitado sem re-chamar handleVerdict", async () => {
    const d = deferred<boolean>();
    const handleVerdict = vi.fn(() => d.promise);
    const { result } = render(handleVerdict);

    let firstResult: Promise<boolean>;
    act(() => {
      firstResult = result.current.submitVerdictSingleFlight("v");
    });
    expect(result.current.isSavingVerdict).toBe(true);
    expect(result.current.isSaveInFlight()).toBe(true);

    // Segundo submit enquanto o primeiro está pendurado.
    let second!: boolean;
    await act(async () => {
      second = await result.current.submitVerdictSingleFlight("v2");
    });
    expect(second).toBe(false);
    expect(handleVerdict).toHaveBeenCalledTimes(1);

    // Concluir o primeiro libera a trava.
    await act(async () => {
      d.resolve(true);
      await firstResult;
    });
    expect(result.current.isSaveInFlight()).toBe(false);
    expect(result.current.isSavingVerdict).toBe(false);
  });

  it("preparePendingVerdict é ignorado durante o in-flight", async () => {
    const d = deferred<boolean>();
    const { result } = render(() => d.promise);
    act(() => {
      result.current.preparePendingVerdict(pending);
    });
    expect(result.current.pendingVerdict).toEqual(pending);

    act(() => void result.current.submitVerdictSingleFlight("v"));
    act(() => {
      result.current.preparePendingVerdict({
        kind: "custom",
        verdict: "outro",
      });
    });
    // Rascunho preservado (não sobrescrito) enquanto salva.
    expect(result.current.pendingVerdict).toEqual(pending);
    await act(async () => {
      d.resolve(true);
    });
  });
});

describe("useCompareVerdictSubmission — confirm/discard", () => {
  it("confirm limpa o pendente no sucesso e mantém na falha", async () => {
    let ok = true;
    const { result } = render(async () => ok);

    act(() => result.current.preparePendingVerdict(pending));
    await act(async () => {
      await result.current.confirmPendingVerdict();
    });
    expect(result.current.pendingVerdict).toBeNull();

    ok = false;
    act(() => result.current.preparePendingVerdict(pending));
    await act(async () => {
      await result.current.confirmPendingVerdict();
    });
    // Falha: rascunho MANTIDO para reconfirmar (#430).
    expect(result.current.pendingVerdict).toEqual(pending);
  });

  it("discard limpa o pendente quando não há save em andamento", () => {
    const { result } = render(async () => true);
    act(() => result.current.preparePendingVerdict(pending));
    act(() => result.current.discardPendingVerdict());
    expect(result.current.pendingVerdict).toBeNull();
  });
});

describe("useCompareVerdictSubmission — guard de render (#430)", () => {
  it("descarta o rascunho pendente ao trocar o par (ctxKey)", () => {
    const { result, rerender } = render(async () => true);
    act(() => result.current.preparePendingVerdict(pending));
    expect(result.current.pendingVerdict).toEqual(pending);

    rerender({ ctxKey: "d1|outroCampo|false" });
    expect(result.current.pendingVerdict).toBeNull();
  });

  it("mantém o rascunho quando o ctxKey não muda", () => {
    const { result, rerender } = render(async () => true);
    act(() => result.current.preparePendingVerdict(pending));
    rerender({ ctxKey: "d1|campo|false" });
    expect(result.current.pendingVerdict).toEqual(pending);
  });
});
