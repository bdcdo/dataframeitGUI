// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QuestionsPanel } from "@/components/coding/QuestionsPanel";
import type { PydanticField } from "@/lib/types";

afterEach(cleanup);

const q1: PydanticField = {
  name: "q1",
  type: "single",
  options: ["sim", "não"],
  description: "Pergunta gatilho",
};
const q2Conditional: PydanticField = {
  name: "q2",
  type: "single",
  options: ["a", "b"],
  description: "Pergunta condicional",
  condition: { field: "q1", equals: "sim" },
};
const q3: PydanticField = {
  name: "q3",
  type: "text",
  options: null,
  description: "Pergunta final",
};

const baseFields = [q1, q2Conditional, q3];

let scrolledInto: Element[];

beforeEach(() => {
  scrolledInto = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolledInto.push(this);
  });
});

function renderPanel(props: {
  fields?: PydanticField[];
  answers: Record<string, unknown>;
}) {
  return render(
    <QuestionsPanel
      fields={props.fields ?? baseFields}
      answers={props.answers}
      onAnswer={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
}

describe("QuestionsPanel — scroll automático em condicional (issue #71)", () => {
  it("não scrolla na hidratação inicial, mesmo com condicional já visível", () => {
    renderPanel({ answers: { q1: "sim" } });
    expect(scrolledInto).toHaveLength(0);
  });

  it("scrolla até a pergunta condicional quando uma resposta a libera", () => {
    const { rerender } = renderPanel({ answers: {} });
    expect(scrolledInto).toHaveLength(0);

    rerender(
      <QuestionsPanel
        fields={baseFields}
        answers={{ q1: "sim" }}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(scrolledInto).toHaveLength(1);
    expect(scrolledInto[0].textContent).toContain("Pergunta condicional");
  });

  it("não scrolla ao mudar resposta de pergunta cuja condicional já estava visível", () => {
    const { rerender } = renderPanel({ answers: { q1: "sim" } });
    expect(scrolledInto).toHaveLength(0);

    // q2 continua visível (condição ainda satisfeita); só q2 ganhou resposta.
    rerender(
      <QuestionsPanel
        fields={baseFields}
        answers={{ q1: "sim", q2: "a" }}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(scrolledInto).toHaveLength(0);
  });

  it("não scrolla quando a prop fields muda (mudança de schema)", () => {
    const { rerender } = renderPanel({ answers: { q1: "sim" } });
    expect(scrolledInto).toHaveLength(0);

    // Novo array de fields introduz outra condicional já satisfeita: como o
    // gatilho foi mudança de schema (não resposta do usuário), não deve rolar.
    const q4Conditional: PydanticField = {
      name: "q4",
      type: "text",
      options: null,
      description: "Outra condicional",
      condition: { field: "q1", equals: "sim" },
    };
    rerender(
      <QuestionsPanel
        fields={[q1, q2Conditional, q4Conditional, q3]}
        answers={{ q1: "sim" }}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(scrolledInto).toHaveLength(0);
  });

  it("scrolla para a primeira condicional quando várias aparecem de uma vez", () => {
    const q2b: PydanticField = {
      name: "q2b",
      type: "text",
      options: null,
      description: "Segunda condicional",
      condition: { field: "q1", equals: "sim" },
    };
    const fields = [q1, q2Conditional, q2b, q3];
    const { rerender } = renderPanel({ fields, answers: {} });

    rerender(
      <QuestionsPanel
        fields={fields}
        answers={{ q1: "sim" }}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(scrolledInto).toHaveLength(1);
    expect(scrolledInto[0].textContent).toContain("Pergunta condicional");
  });
});
