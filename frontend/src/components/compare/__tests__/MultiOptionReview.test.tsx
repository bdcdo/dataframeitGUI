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
        readOnly={false}
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
        readOnly={false}
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

  it("bloqueia controles e atalhos enquanto a submissão está em andamento", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MultiOptionReview
        readOnly={false}
        options={["A", "B"]}
        responses={[]}
        existingVerdict={null}
        isSubmitting
        onSubmit={onSubmit}
      />,
    );

    const confirmButton = screen.getByRole("button", { name: "Salvando..." });
    expect(confirmButton).toHaveProperty("disabled", true);
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toHaveProperty("disabled", true);
    }

    await user.keyboard("1");
    await user.keyboard("{Enter}");

    expect(
      screen.getAllByRole("checkbox")[0].getAttribute("aria-checked"),
    ).toBe("false");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("modo somente leitura bloqueia clique, números e Enter sem alterar o estado exibido", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MultiOptionReview
        readOnly={true}
        options={["A", "B"]}
        responses={[]}
        existingVerdict={{
          verdict: '{"A":true,"B":false}',
          chosenResponseId: null,
          comment: null,
        }}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[0].getAttribute("aria-checked")).toBe("true");
    expect((boxes[0] as HTMLButtonElement).disabled).toBe(true);

    await user.click(boxes[0]);
    await user.keyboard("12{Enter}");
    await user.click(screen.getByRole("button", { name: "Somente leitura" }));

    expect(boxes[0].getAttribute("aria-checked")).toBe("true");
    expect(boxes[1].getAttribute("aria-checked")).toBe("false");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("MultiOptionReview — reset via key (contrato do ComparisonPanel)", () => {
  it("trocar a key (novo documento/campo) remonta e re-inicializa as escolhas", async () => {
    const user = userEvent.setup();
    // O harness espelha ComparisonPanel.tsx:183: key={`${documentId}|${fieldName}`}.
    const { rerender } = render(
      <MultiOptionReview
        key="doc1|campoA"
        readOnly={false}
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
        readOnly={false}
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

// `choices` é inicializado UMA vez (o reset é por `key` no pai), então uma
// opção que entra em `options` sem troca de documento/campo — a união de
// opções do ComparisonPanel recalcula quando as respostas são refetchadas —
// não tem chave no mapa de escolhas. Como `isAnswerCorrect` compara conjuntos,
// gravar o mapa cru deixaria a opção exibida fora do veredito: a mesma classe
// de bug do #484, em escala menor.
describe("MultiOptionReview — veredito cobre toda opção exibida", () => {
  it("opção que entra em options depois do mount sai no veredito", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(
      <MultiOptionReview
        key="doc1|campoA"
        readOnly={false}
        options={["A"]}
        responses={[]}
        existingVerdict={null}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );

    // Mesma key: sem remount, o inicializador NÃO roda de novo e "Z" nunca
    // entra em `choices`.
    rerender(
      <MultiOptionReview
        key="doc1|campoA"
        readOnly={false}
        options={["A", "Z"]}
        responses={[]}
        existingVerdict={null}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /Confirmar/i }));

    expect(JSON.parse(onSubmit.mock.calls[0][0])).toEqual({
      A: false,
      Z: false,
    });
  });

  it("veredito salvo sem a chave de uma opção exibida é completado", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MultiOptionReview
        readOnly={false}
        options={["A", "Z"]}
        responses={[]}
        // Veredito gravado antes do #484: só tem as opções do schema da época.
        existingVerdict={{
          verdict: '{"A":true}',
          chosenResponseId: null,
          comment: null,
        }}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Confirmar/i }));

    expect(JSON.parse(onSubmit.mock.calls[0][0])).toEqual({
      A: true,
      Z: false,
    });
  });
});
