// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

// Stub do QuestionsPanel: expõe os callbacks como botões para testar a fiação
// do BrowseDocCoder (seed → answers prop, onAnswer/onNotesChange → onDraftChange,
// onSubmit → onSubmit(answers, notes)) sem o comportamento interno do painel.
vi.mock("@/components/coding/QuestionsPanel", () => ({
  QuestionsPanel: ({
    answers,
    notes,
    onAnswer,
    onNotesChange,
    onSubmit,
  }: {
    answers: Record<string, unknown>;
    notes?: string;
    onAnswer: (f: string, v: unknown) => void;
    onNotesChange?: (n: string) => void;
    onSubmit: () => void;
  }) => (
    <div>
      <div data-testid="answers">{JSON.stringify(answers)}</div>
      <div data-testid="notes">{notes}</div>
      <button onClick={() => onAnswer("q1", "sim")}>set-q1</button>
      <button onClick={() => onNotesChange?.("minha nota")}>set-notes</button>
      <button onClick={onSubmit}>enviar</button>
    </div>
  ),
}));
vi.mock("@/components/coding/DocumentReader", () => ({
  DocumentReader: ({ text }: { text: string }) => (
    <div data-testid="doc-reader">{text}</div>
  ),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));

import { BrowseDocCoder } from "@/components/coding/BrowseDocCoder";
import type { CodingDocument } from "@/hooks/useDocumentForCoding";

function makeDoc(overrides?: Partial<CodingDocument>): CodingDocument {
  return {
    document: { id: "d1", external_id: "ext-d1", title: "Doc Um", text: "texto do doc", exclusionPending: null },
    initialAnswers: { q0: "x" },
    initialNotes: "nota0",
    ...overrides,
  };
}

const baseProps = {
  fields: [],
  submitting: false,
  readOnly: false,
  isFullscreen: false,
  title: "Doc Um",
  responseCount: 0,
  onToggleFullscreen: vi.fn(),
  onReorder: vi.fn(),
};

afterEach(cleanup);
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
});

describe("BrowseDocCoder", () => {
  it("semeia respostas e notas do doc carregado e mostra o texto", () => {
    render(
      <BrowseDocCoder
        {...baseProps}
        doc={makeDoc()}
        onSubmit={vi.fn()}
        onDraftChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("doc-reader").textContent).toBe("texto do doc");
    expect(screen.getByTestId("answers").textContent).toBe('{"q0":"x"}');
    expect(screen.getByTestId("notes").textContent).toBe("nota0");
  });

  it("reporta o rascunho ao editar resposta (merge sobre o seed)", async () => {
    const onDraftChange = vi.fn();
    render(
      <BrowseDocCoder
        {...baseProps}
        doc={makeDoc()}
        onSubmit={vi.fn()}
        onDraftChange={onDraftChange}
      />,
    );
    await userEvent.click(screen.getByText("set-q1"));
    expect(onDraftChange).toHaveBeenCalledWith({
      answers: { q0: "x", q1: "sim" },
      notes: "nota0",
    });
    expect(screen.getByTestId("answers").textContent).toBe('{"q0":"x","q1":"sim"}');
  });

  it("reporta o rascunho ao editar nota", async () => {
    const onDraftChange = vi.fn();
    render(
      <BrowseDocCoder
        {...baseProps}
        doc={makeDoc()}
        onSubmit={vi.fn()}
        onDraftChange={onDraftChange}
      />,
    );
    await userEvent.click(screen.getByText("set-notes"));
    expect(onDraftChange).toHaveBeenCalledWith({
      answers: { q0: "x" },
      notes: "minha nota",
    });
  });

  it("acumula edições sequenciais de resposta e nota no mesmo rascunho", async () => {
    const onDraftChange = vi.fn();
    render(
      <BrowseDocCoder
        {...baseProps}
        doc={makeDoc()}
        onSubmit={vi.fn()}
        onDraftChange={onDraftChange}
      />,
    );
    await userEvent.click(screen.getByText("set-q1"));
    await userEvent.click(screen.getByText("set-notes"));
    // A 2ª edição (nota) não perde a 1ª (resposta): ambas no rascunho final.
    expect(onDraftChange).toHaveBeenLastCalledWith({
      answers: { q0: "x", q1: "sim" },
      notes: "minha nota",
    });
  });

  it("congela a edição enquanto submitting (não perde teclas durante o save em voo)", async () => {
    const onDraftChange = vi.fn();
    render(
      <BrowseDocCoder
        {...baseProps}
        submitting
        doc={makeDoc()}
        onSubmit={vi.fn()}
        onDraftChange={onDraftChange}
      />,
    );
    await userEvent.click(screen.getByText("set-q1"));
    await userEvent.click(screen.getByText("set-notes"));
    // Com um save em voo, as edições são ignoradas: nada reportado para cima e o
    // estado exibido permanece no seed (o container já salvou o snapshot).
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("answers").textContent).toBe('{"q0":"x"}');
    expect(screen.getByTestId("notes").textContent).toBe("nota0");
  });

  it("envia com as respostas e notas atuais", async () => {
    const onSubmit = vi.fn();
    render(
      <BrowseDocCoder
        {...baseProps}
        doc={makeDoc()}
        onSubmit={onSubmit}
        onDraftChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByText("set-q1"));
    await userEvent.click(screen.getByText("enviar"));
    expect(onSubmit).toHaveBeenCalledWith({
      answers: { q0: "x", q1: "sim" },
      notes: "nota0",
    });
  });
});
