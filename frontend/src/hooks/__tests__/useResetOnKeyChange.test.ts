// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useResetOnKeyChange } from "../useResetOnKeyChange";

afterEach(cleanup);

function setup(initialKey: string) {
  const onKeyChange = vi.fn();
  const { rerender } = renderHook(
    ({ key }) => useResetOnKeyChange(key, onKeyChange),
    { initialProps: { key: initialKey } }
  );
  return { onKeyChange, rerender };
}

describe("useResetOnKeyChange", () => {
  it("não chama onKeyChange no primeiro render", () => {
    const { onKeyChange } = setup("a");
    expect(onKeyChange).not.toHaveBeenCalled();
  });

  it("não chama onKeyChange ao re-renderizar com a mesma key", () => {
    const { onKeyChange, rerender } = setup("a");
    rerender({ key: "a" });
    expect(onKeyChange).not.toHaveBeenCalled();
  });

  it("chama onKeyChange exatamente uma vez quando a key muda", () => {
    const { onKeyChange, rerender } = setup("a");
    rerender({ key: "b" });
    expect(onKeyChange).toHaveBeenCalledTimes(1);
    rerender({ key: "b" });
    expect(onKeyChange).toHaveBeenCalledTimes(1);
  });

  it("usa o onKeyChange mais recente (fechamento não fica preso ao primeiro render)", () => {
    let seen = -1;
    const { rerender } = renderHook(
      ({ key, value }: { key: string; value: number }) =>
        useResetOnKeyChange(key, () => {
          seen = value;
        }),
      { initialProps: { key: "a", value: 1 } }
    );
    rerender({ key: "a", value: 2 });
    rerender({ key: "b", value: 2 });
    expect(seen).toBe(2);
  });
});
