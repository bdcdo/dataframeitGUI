// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  AutoReviewFieldPanel,
  type AutoReviewField,
} from "../AutoReviewFieldPanel";

afterEach(cleanup);

const field: AutoReviewField = {
  fieldName: "diagnostico",
  fieldDescription: "Diagnóstico principal",
  humanAnswer: "Sim",
  llmAnswer: "Não",
  llmJustification: null,
  alreadyAnswered: false,
  selfJustification: null,
};

function renderPanel(props: Partial<Parameters<typeof AutoReviewFieldPanel>[0]> = {}) {
  render(
    <AutoReviewFieldPanel
      field={field}
      fieldIndex={0}
      totalFields={2}
      answered={[false, false]}
      incomplete={[false, false]}
      choice={null}
      justification=""
      readOnly={false}
      readyCount={0}
      incompleteCount={0}
      submitting={false}
      canSubmit={false}
      onSubmit={vi.fn()}
      onChoose={vi.fn()}
      onJustificationChange={vi.fn()}
      onFieldNavigate={vi.fn()}
      {...props}
    />,
  );
}

describe("AutoReviewFieldPanel", () => {
  // O painel remonta via key={currentKey} no pai a cada (doc, campo) — então
  // testamos o efeito de foco no cenário real: mount já com o verdict que
  // exige justificativa (não um clique local, já que `choice` é controlado
  // pelo pai via prop).
  it("monta com um verdict que exige justificativa e foca o textarea", () => {
    renderPanel({ choice: "contesta_llm" });

    const textarea = screen.getByLabelText(/Justificativa/);
    expect(document.activeElement).toBe(textarea);
  });

  it("exibe o aviso de obrigatoriedade com a justificativa vazia", () => {
    renderPanel({ choice: "contesta_llm", justification: "" });

    expect(
      screen.queryByText(/Obrigatória: sem ela este campo não é enviado\./),
    ).not.toBeNull();
  });
});
