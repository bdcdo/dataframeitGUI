// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MultiOptionReview } from "@/components/compare/MultiOptionReview";

afterEach(cleanup);

describe("MultiOptionReview — atalhos de teclado", () => {
  it("tecla numérica alterna a opção e Enter submete o estado fresco", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MultiOptionReview
        options={["A", "B", "C"]}
        responses={[]}
        existingVerdict={null}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );

    // Estado inicial (sem respostas): todas as opções desmarcadas.
    await user.keyboard("1"); // alterna A
    await user.keyboard("2"); // alterna B
    await user.keyboard("{Enter}"); // submete

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // O handler chega fresco via ref: o Enter vê os dois toggles acumulados,
    // não um estado stale do primeiro registro do listener.
    expect(JSON.parse(onSubmit.mock.calls[0][0])).toEqual({
      A: true,
      B: true,
      C: false,
    });
  });

  it("tecla numérica fora do intervalo de opções não altera nada", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MultiOptionReview
        options={["A", "B"]}
        responses={[]}
        existingVerdict={null}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );

    await user.keyboard("9"); // não há 9ª opção → no-op
    await user.keyboard("{Enter}");

    expect(JSON.parse(onSubmit.mock.calls[0][0])).toEqual({
      A: false,
      B: false,
    });
  });
});

describe("MultiOptionReview — reset via key (contrato do ComparisonPanel)", () => {
  it("trocar a key (novo documento/campo) remonta e re-inicializa as escolhas", async () => {
    const user = userEvent.setup();
    // O harness espelha ComparisonPanel.tsx:183: key={`${documentId}|${fieldName}`}.
    const { rerender } = render(
      <MultiOptionReview
        key="doc1|campoA"
        options={["A", "B"]}
        responses={[]}
        existingVerdict={null}
        isSubmitting={false}
        onSubmit={vi.fn()}
      />,
    );

    let boxes = screen.getAllByRole("checkbox");
    expect(boxes[0].getAttribute("aria-checked")).toBe("false");

    // Usuário marca a opção A no campo atual.
    await user.click(boxes[0]);
    expect(screen.getAllByRole("checkbox")[0].getAttribute("aria-checked")).toBe(
      "true",
    );

    // Navega para outro campo (key muda) com um verdict salvo diferente.
    // O remount descarta o toggle em curso e roda o inicializador de novo.
    rerender(
      <MultiOptionReview
        key="doc1|campoB"
        options={["A", "B"]}
        responses={[]}
        existingVerdict={{
          verdict: '{"A":false,"B":true}',
          chosenResponseId: null,
          comment: null,
        }}
        isSubmitting={false}
        onSubmit={vi.fn()}
      />,
    );

    boxes = screen.getAllByRole("checkbox");
    expect(boxes[0].getAttribute("aria-checked")).toBe("false"); // A foi resetado
    expect(boxes[1].getAttribute("aria-checked")).toBe("true"); // B vem do novo verdict
  });
});
