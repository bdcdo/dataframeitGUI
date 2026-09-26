// @vitest-environment jsdom
// O voto pelo teclado (tecla do número do card) segue a mesma regra do card:
// resposta fora das opções atuais não vira rascunho de veredito.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import type { PydanticField } from "@/lib/types";
import type { FieldResponse } from "@/components/compare/compare-types";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError, info: vi.fn(), success: vi.fn() } }));

import { useCompareKeyboard } from "@/components/compare/useCompareKeyboard";

afterEach(() => {
  cleanup();
  toastError.mockClear();
});

const FIELD: PydanticField = {
  id: "00000000-0000-4000-8000-000000000001", name: "q", type: "single",
  options: ["Sim", "Não"], description: "", hash: "aaaaaaaaaaaa",
};

function group(id: string, answer: string): FieldResponse[] {
  return [{ id, answer } as FieldResponse];
}

function setup() {
  const onPrepareVerdict = vi.fn();
  renderHook(() => useCompareKeyboard({
    readOnly: false, isFullscreen: false, isCurrentDocComplete: false, isCurrentFieldDivergent: true,
    currentField: FIELD, answerGroups: [group("r1", "Sim"), group("r2", "Talvez")],
    origin: { documentId: "doc1", fieldName: "q" },
    onToggleFullscreen: vi.fn(), onExitFullscreen: vi.fn(), onNextField: vi.fn(), onPrevField: vi.fn(),
    onPrepareVerdict, onSubmitSpecialVerdict: vi.fn(), onConfirmPendingVerdict: vi.fn(), hasPendingVerdict: false,
  }));
  return { onPrepareVerdict };
}

describe("useCompareKeyboard — voto em resposta fora das opções atuais", () => {
  it("não prepara o rascunho e avisa o motivo", () => {
    const { onPrepareVerdict } = setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    expect(onPrepareVerdict).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/não está mais no formulário/), expect.anything());
  });

  it("resposta nas opções atuais prepara o rascunho", () => {
    const { onPrepareVerdict } = setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
    expect(onPrepareVerdict).toHaveBeenCalledWith(expect.objectContaining({ kind: "response", verdict: "Sim", chosenResponseId: "r1" }));
    expect(toastError).not.toHaveBeenCalled();
  });
});
