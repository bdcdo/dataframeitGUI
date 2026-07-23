// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { useQuestionValidation } from "@/components/coding/useQuestionValidation";
import type { PydanticField } from "@/lib/types";

const warn = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    warning: (...args: unknown[]) => warn(...args),
  },
}));

// Helper: PydanticField com defaults mínimos (mesmo shape do coding-completeness.test).
function field(partial: Partial<PydanticField> & { name: string }): PydanticField {
  return {
    type: "single",
    options: ["a", "b"],
    description: "",
    ...partial,
  } as PydanticField;
}

// Monta um RefObject de cards que espelham a estrutura real de `SortableQuestion`
// no fluxo de codificação (arrastável): o drag-handle é o PRIMEIRO focável do
// card, seguido do corpo da resposta `[data-question-body]` com o input. Isso é
// necessário para provar o vermelho do foco — com o seletor escopado ao card
// inteiro, o `.focus()` cairia no handle; escopado ao corpo, cai no input.
function refsFor(fields: PydanticField[]): RefObject<(HTMLDivElement | null)[]> {
  const ref = createRef<(HTMLDivElement | null)[]>() as {
    current: (HTMLDivElement | null)[];
  };
  ref.current = fields.map(() => {
    const card = document.createElement("div");
    const handle = document.createElement("button");
    handle.setAttribute("aria-label", "Arrastar para reordenar pergunta");
    card.appendChild(handle);
    const body = document.createElement("div");
    body.setAttribute("data-question-body", "");
    const input = document.createElement("input");
    body.appendChild(input);
    card.appendChild(body);
    document.body.appendChild(card);
    return card;
  });
  return ref as RefObject<(HTMLDivElement | null)[]>;
}

beforeEach(() => {
  warn.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function setup(
  visibleFields: PydanticField[],
  answers: Record<string, unknown>,
  overrides: { submitting?: boolean; outOfScopeBlocked?: boolean } = {},
) {
  const onSubmit = vi.fn();
  const onAnswer = vi.fn();
  const refs = refsFor(visibleFields);
  const view = renderHook(() =>
    useQuestionValidation(
      visibleFields,
      answers,
      onAnswer,
      onSubmit,
      overrides.submitting ?? false,
      overrides.outOfScopeBlocked ?? false,
      refs,
    ),
  );
  return { view, onSubmit, onAnswer, refs };
}

describe("useQuestionValidation — envio", () => {
  it("tudo preenchido → chama onSubmit, sem aviso", () => {
    const fields = [field({ name: "q1" }), field({ name: "q2" })];
    const { view, onSubmit } = setup(fields, { q1: "a", q2: "b" });
    act(() => view.result.current.handleSubmitWithValidation());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("obrigatória visível vazia → bloqueia, destaca, rola/foca o 1º pendente e avisa", () => {
    const fields = [field({ name: "q1" }), field({ name: "q2" })];
    const { view, onSubmit, refs } = setup(fields, { q1: "a" });
    act(() => view.result.current.handleSubmitWithValidation());

    expect(onSubmit).not.toHaveBeenCalled();
    expect(view.result.current.highlightedFields).toEqual(new Set(["q2"]));
    expect(warn).toHaveBeenCalledWith("Preencha todas as perguntas obrigatórias");
    // q2 é o índice 1 em visibleFields; scroll no card e foco no input do corpo
    // da resposta — NÃO no drag-handle, que é o primeiro focável do card.
    const secondCard = refs.current![1]!;
    expect(secondCard.scrollIntoView).toHaveBeenCalled();
    const bodyInput = secondCard.querySelector("[data-question-body] input");
    expect(document.activeElement).toBe(bodyInput);
    expect(document.activeElement).not.toBe(
      secondCard.querySelector('[aria-label="Arrastar para reordenar pergunta"]'),
    );
  });

  it("submitting/outOfScopeBlocked → nunca envia nem avisa", () => {
    const fields = [field({ name: "q1" })];
    const a = setup(fields, { q1: "a" }, { submitting: true });
    act(() => a.view.result.current.handleSubmitWithValidation());
    expect(a.onSubmit).not.toHaveBeenCalled();

    const b = setup(fields, {}, { outOfScopeBlocked: true });
    act(() => b.view.result.current.handleSubmitWithValidation());
    expect(b.onSubmit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("useQuestionValidation — régua única (coding-completeness)", () => {
  // Prova do vermelho: com a régua antiga (`visibleFields.filter(resolveRequired)`),
  // o campo llm_only entrava no denominador da contagem e o header mostrava 1/2
  // para sempre, embora o submit já o ignorasse. Ao delegar a `requiredHumanFields`,
  // contagem e bloqueio passam a excluí-lo igualmente.
  it("campo obrigatório llm_only não entra na contagem nem bloqueia o envio", () => {
    const fields = [
      field({ name: "humano" }),
      field({ name: "so_llm", target: "llm_only" }),
    ];
    const { view, onSubmit } = setup(fields, { humano: "a" });
    expect(view.result.current.requiredFields.map((f) => f.name)).toEqual(["humano"]);
    expect(view.result.current.answeredRequiredCount).toBe(1);
    act(() => view.result.current.handleSubmitWithValidation());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("'Outro: ' incompleto e multi vazio contam como não respondidos (delega isFieldAnswered)", () => {
    const fields = [
      field({ name: "q1", allow_other: true }),
      field({ name: "q2", type: "multi", allow_other: true }),
    ];
    const { view, onSubmit } = setup(fields, { q1: "Outro: ", q2: [] });
    expect(view.result.current.answeredRequiredCount).toBe(0);
    act(() => view.result.current.handleSubmitWithValidation());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(view.result.current.highlightedFields).toEqual(new Set(["q1", "q2"]));
  });
});
