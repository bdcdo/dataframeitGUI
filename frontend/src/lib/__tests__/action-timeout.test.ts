import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_TIMEOUT_MESSAGE,
  ACTION_TIMEOUT_MS,
  ActionTimeoutError,
  withActionTimeout,
} from "@/lib/action-timeout";
import { withErrorCode } from "@/lib/server-error";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withActionTimeout", () => {
  it("devolve o valor da action que responde dentro do prazo", async () => {
    await expect(withActionTimeout(Promise.resolve({ ok: 1 }))).resolves.toEqual({
      ok: 1,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("repassa a rejeição da action sem esperar o prazo", async () => {
    const error = new Error("boom");
    await expect(withActionTimeout(Promise.reject(error))).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejeita com ActionTimeoutError quando a action nunca responde", async () => {
    const pending = withActionTimeout(new Promise(() => {}));
    const settled = vi.fn();
    pending.catch(settled);
    await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(expect.any(ActionTimeoutError));
  });

  it("ignora o settle que chega depois do prazo", async () => {
    let resolveLate!: (value: string) => void;
    const pending = withActionTimeout(
      new Promise<string>((resolve) => {
        resolveLate = resolve;
      }),
      10,
    );
    const onValue = vi.fn();
    const onError = vi.fn();
    pending.then(onValue, onError);
    await vi.advanceTimersByTimeAsync(10);
    resolveLate("tarde");
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onValue).not.toHaveBeenCalled();
  });
});

describe("withErrorCode com timeout", () => {
  it("troca a copy do fluxo pelo aviso de que o envio não respondeu", () => {
    expect(withErrorCode(new ActionTimeoutError(10), "Não foi possível enviar.")).toBe(
      ACTION_TIMEOUT_MESSAGE,
    );
  });
});
