// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { BlindPhase } from "../BlindPhase";
import type { ArbitrationField } from "../ArbitrationPage";
import type { PydanticField } from "@/lib/types";

afterEach(cleanup);

function field(over: Partial<ArbitrationField> = {}): ArbitrationField {
  return {
    fieldReviewId: "f1",
    fieldName: "q1",
    aAnswer: "Resposta A!",
    bAnswer: "Resposta B!",
    blindVerdict: null,
    reveal: null,
    ...over,
  };
}

const meta = (name: string, description: string): [string, PydanticField] => [
  name,
  { name, type: "single", options: null, description },
];

describe("BlindPhase", () => {
  it("renderiza um card por campo, com nome e descrição do meta", () => {
    render(
      <BlindPhase
        fields={[
          field({ fieldReviewId: "f1", fieldName: "q1" }),
          field({ fieldReviewId: "f2", fieldName: "q2" }),
        ]}
        fieldMeta={new Map([meta("q1", "Descrição um"), meta("q2", "Descrição dois")])}
        choices={{}}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.getByText("q1")).toBeTruthy();
    expect(screen.getByText("q2")).toBeTruthy();
    expect(screen.getByText("Descrição um")).toBeTruthy();
    expect(screen.getByText("Descrição dois")).toBeTruthy();
  });

  it("clicar em Resposta A/B chama onChoose com a escolha", () => {
    const onChoose = vi.fn();
    render(
      <BlindPhase
        fields={[field()]}
        fieldMeta={new Map([meta("q1", "d")])}
        choices={{}}
        onChoose={onChoose}
      />,
    );
    fireEvent.click(screen.getByText("Resposta A").closest("button")!);
    expect(onChoose).toHaveBeenCalledWith("f1", "a");
    fireEvent.click(screen.getByText("Resposta B").closest("button")!);
    expect(onChoose).toHaveBeenCalledWith("f1", "b");
  });

  it("mostra o valor formatado de cada resposta", () => {
    render(
      <BlindPhase
        fields={[field({ aAnswer: "sim", bAnswer: "" })]}
        fieldMeta={new Map([meta("q1", "d")])}
        choices={{}}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.getByText("sim")).toBeTruthy();
    // string vazia → "(vazio)" via formatAnswerDisplay
    expect(screen.getByText("(vazio)")).toBeTruthy();
  });

  it("campo já decidido (blindVerdict) trava os botões e mostra aviso", () => {
    render(
      <BlindPhase
        fields={[
          field({
            blindVerdict: "humano",
            reveal: {
              aSide: "humano",
              bSide: "llm",
              humanName: null,
              llmName: null,
              llmJustification: null,
              selfJustification: null,
            },
          }),
        ]}
        fieldMeta={new Map([meta("q1", "d")])}
        choices={{}}
        onChoose={vi.fn()}
      />,
    );
    expect(
      (screen.getByText("Resposta A").closest("button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByText("Resposta B").closest("button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText(/Veredito cego já registrado/),
    ).toBeTruthy();
  });
});
