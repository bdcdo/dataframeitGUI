// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Filhos que tocam Server Actions / dialogs ficam fora do escopo: este teste
// cobre só o fluxo de "resposta nova" (issue #247, ponto 4).
vi.mock("@/components/shared/AddNoteButton", () => ({
  AddNoteButton: () => <button type="button">Anotar</button>,
}));
vi.mock("@/components/stats/SuggestFieldDialog", () => ({
  SuggestFieldDialog: () => null,
}));

import { ComparisonPanel } from "@/components/compare/ComparisonPanel";
import type { PydanticField } from "@/lib/types";

afterEach(cleanup);

const FIELD: PydanticField = {
  name: "data_parecer",
  type: "date",
  description: "Data do parecer",
} as PydanticField;

function renderPanel(
  props: Partial<Parameters<typeof ComparisonPanel>[0]> = {},
) {
  const onVerdict = vi.fn();
  render(
    <ComparisonPanel
      projectId="p1"
      documentId="d1"
      documentTitle="Nota técnica 1"
      fieldName="data_parecer"
      fieldDescription="Data do parecer"
      fieldType="date"
      fieldOptions={null}
      fields={[FIELD]}
      fieldIndex={0}
      totalFields={1}
      responses={[
        {
          id: "r-llm",
          respondent_type: "llm",
          respondent_name: "Robô",
          answer: "2021-05-10",
          is_latest: true,
          isFieldStale: false,
        },
      ]}
      existingVerdict={null}
      reviewed={[false]}
      isDivergent={true}
      isDocComplete={false}
      hasNextDoc={false}
      onNextDoc={vi.fn()}
      onFieldNavigate={vi.fn()}
      onVerdict={onVerdict}
      onMarkReviewed={vi.fn()}
      comment=""
      onCommentChange={vi.fn()}
      commentCount={0}
      suggestionCount={0}
      allowEquivalence={false}
      equivalences={[]}
      onConfirmEquivalent={vi.fn(async () => {})}
      onUnmarkEquivalencePair={vi.fn(async () => {})}
      currentUserId="u1"
      canManageAnyPair={false}
      {...props}
    />,
  );
  return { onVerdict };
}

describe("ComparisonPanel — resposta nova (issue #247, ponto 4)", () => {
  it("o input de resposta nova fica oculto até clicar em 'Nenhuma correta'", () => {
    renderPanel();
    expect(screen.queryByPlaceholderText("Resposta correta…")).toBeNull();
    expect(
      screen.getByRole("button", { name: /nenhuma correta/i }),
    ).toBeTruthy();
  });

  it("confirma o valor digitado como verdict SEM chosenResponseId", async () => {
    const user = userEvent.setup();
    const { onVerdict } = renderPanel();

    await user.click(screen.getByRole("button", { name: /nenhuma correta/i }));
    const input = screen.getByPlaceholderText("Resposta correta…");
    await user.type(input, "sem data no parecer");
    await user.click(
      screen.getByRole("button", { name: /confirmar resposta nova/i }),
    );

    expect(onVerdict).toHaveBeenCalledTimes(1);
    // 2º argumento (chosenResponseId) ausente: nenhuma resposta existente é o
    // gabarito — é um valor novo do revisor.
    expect(onVerdict).toHaveBeenCalledWith("sem data no parecer");
    expect(onVerdict.mock.calls[0][1]).toBeUndefined();
  });

  it("Enter no input também confirma; valor em branco não dispara", async () => {
    const user = userEvent.setup();
    const { onVerdict } = renderPanel();

    await user.click(screen.getByRole("button", { name: /nenhuma correta/i }));
    const input = screen.getByPlaceholderText("Resposta correta…");

    // só espaços → não confirma
    await user.type(input, "   {Enter}");
    expect(onVerdict).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "8 meses{Enter}");
    expect(onVerdict).toHaveBeenCalledWith("8 meses");
  });
});
