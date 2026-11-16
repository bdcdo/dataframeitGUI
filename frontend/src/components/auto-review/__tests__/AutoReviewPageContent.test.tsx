// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  submitAutoReview: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/actions/field-reviews", () => ({
  submitAutoReview: mocks.submitAutoReview,
}));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));
// O painel real não importa aqui: o que está em teste é o envio. O stub expõe
// o botão de envio e o estado `submitting` que o painel recebe.
vi.mock("../AutoReviewFieldPanel", () => ({
  AutoReviewFieldPanel: ({
    submitting,
    canSubmit,
    onSubmit,
  }: {
    submitting: boolean;
    canSubmit: boolean;
    onSubmit: () => void;
  }) => (
    <button type="button" disabled={!canSubmit} onClick={onSubmit}>
      {submitting ? "Enviando" : "Enviar"}
    </button>
  ),
}));

import { AutoReviewPageContent } from "../AutoReviewPageContent";
import type { AutoReviewDoc } from "../AutoReviewPage";
import { maskedServerError } from "@/test-utils/masked-server-error";
import { ACTION_TIMEOUT_MESSAGE, ACTION_TIMEOUT_MS } from "@/lib/action-timeout";

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  // A rejeição é logada antes do toast; silencia a saída no teste.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const doc: AutoReviewDoc = {
  docId: "doc-1",
  title: "Doc",
  externalId: null,
  text: "texto",
  fields: [
    {
      fieldReviewId: "fr-1",
      fieldName: "q1",
      fieldDescription: null,
      fieldHelpText: null,
      humanAnswer: "A",
      llmAnswer: "B",
      llmJustification: null,
      alreadyAnswered: false,
      selfJustification: null,
    },
  ],
};

function renderContent() {
  const setChoices = vi.fn();
  render(
    <AutoReviewPageContent
      doc={doc}
      projectId="project-1"
      readOnly={false}
      choices={{ "fr-1": "admite_erro" }}
      justifications={{}}
      setChoices={setChoices}
      setJustifications={vi.fn()}
    />,
  );
  return { setChoices };
}

describe("AutoReviewPageContent — envio", () => {
  it("envia os campos prontos, confirma e recarrega", async () => {
    mocks.submitAutoReview.mockResolvedValue({ success: true });
    renderContent();

    await userEvent.setup().click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.submitAutoReview).toHaveBeenCalledWith("project-1", "doc-1", [
      {
        fieldReviewId: "fr-1",
        fieldName: "q1",
        verdict: "admite_erro",
        justification: undefined,
      },
    ]);
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("libera o botão e informa erro quando a action rejeita", async () => {
    mocks.submitAutoReview.mockRejectedValue(maskedServerError());
    const { setChoices } = renderContent();

    await userEvent.setup().click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Não foi possível enviar a revisão. Tente novamente. — código 1bkm1w6",
      ),
    );
    expect(console.error).toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Enviar" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    // As escolhas ficam para o pesquisador tentar de novo.
    expect(setChoices).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("libera o botão e avisa quando a action nunca responde", async () => {
    mocks.submitAutoReview.mockReturnValue(new Promise(() => {}));
    const { setChoices } = renderContent();
    const button = screen.getByRole("button", { name: "Enviar" }) as HTMLButtonElement;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(button);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(button.disabled).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS));

    expect(mocks.toastError).toHaveBeenCalledWith(ACTION_TIMEOUT_MESSAGE);
    expect(button.disabled).toBe(false);
    expect(setChoices).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
