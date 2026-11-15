// @vitest-environment jsdom
// O listener de teclado só é religado quando muda algo que o handler LÊ. A
// completude do documento não é lida por atalho nenhum (o "Próximo parecer"
// recebe foco e o Enter nativo do botão avança), então concluir o documento
// não pode derrubar e religar o listener (#616).
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useCompareKeyboard } from "@/components/compare/useCompareKeyboard";
import { keyboardParams } from "./compare-test-helpers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const params = keyboardParams();

describe("useCompareKeyboard: listener de teclado", () => {
  it("não é religado quando o documento passa a estar concluído", () => {
    const add = vi.spyOn(window, "addEventListener");
    const keydownBindings = () =>
      add.mock.calls.filter(([type]) => type === "keydown").length;

    // A completude entra por spread, e não como propriedade escrita: o hook
    // não a declara, e o que se fixa aqui é justamente que ela não é insumo
    // do effect — quem a passar (como o ComparePage passava) não religa nada.
    const { rerender } = renderHook(
      ({ docState }: { docState: { isCurrentDocComplete: boolean } }) =>
        useCompareKeyboard({ ...params, ...docState }),
      { initialProps: { docState: { isCurrentDocComplete: false } } },
    );
    expect(keydownBindings()).toBe(1);

    rerender({ docState: { isCurrentDocComplete: true } });
    expect(keydownBindings()).toBe(1);
  });
});
