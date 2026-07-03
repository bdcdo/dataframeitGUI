// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { AutoReviewFieldPanel } from "@/components/auto-review/AutoReviewFieldPanel";
import type { AutoReviewField } from "@/components/auto-review/AutoReviewFieldPanel";

afterEach(cleanup);

const FIELD: AutoReviewField = {
  fieldName: "data_parecer",
  fieldDescription: "Data do parecer",
  fieldHelpText: null,
  humanAnswer: "2026-01-01",
  llmAnswer: "2026-01-02",
  llmJustification: null,
  alreadyAnswered: false,
  selfJustification: null,
};

function renderPanel(field: AutoReviewField) {
  render(
    <AutoReviewFieldPanel
      field={field}
      fieldIndex={0}
      totalFields={1}
      answered={[false]}
      incomplete={[false]}
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
    />,
  );
}

describe("AutoReviewFieldPanel — help_text (#373)", () => {
  it("shows the help text when the field has one", () => {
    renderPanel({
      ...FIELD,
      fieldHelpText: "Considere apenas o dispositivo final da decisão.",
    });
    expect(
      screen.getByText("Considere apenas o dispositivo final da decisão."),
    ).toBeTruthy();
  });

  it("renders nothing extra when the field has no help text", () => {
    renderPanel(FIELD);
    expect(screen.queryByText(/Considere apenas/)).toBeNull();
  });
});
