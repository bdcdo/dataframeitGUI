// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

// Painéis resizable usam ResizeObserver (ausente em jsdom) — passthrough.
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));
vi.mock("@/components/coding/DocumentReader", () => ({
  DocumentReader: ({ text }: { text: string }) => (
    <div data-testid="doc-reader">{text}</div>
  ),
}));
vi.mock("../BlindPhase", () => ({
  BlindPhase: ({
    onChoose,
  }: {
    onChoose: (id: string, c: "a" | "b") => void;
  }) => (
    <button data-testid="blind-phase" onClick={() => onChoose("f1", "a")}>
      blind
    </button>
  ),
}));
vi.mock("../RevealPhase", () => ({
  RevealPhase: ({
    onChooseFinal,
  }: {
    onChooseFinal: (id: string, v: string) => void;
  }) => (
    <button data-testid="reveal-phase" onClick={() => onChooseFinal("f1", "llm")}>
      reveal
    </button>
  ),
}));
vi.mock("../ArbitrationDocList", () => ({
  ArbitrationDocList: ({
    currentIndex,
    collapsed,
    onSelect,
    onToggle,
  }: {
    currentIndex: number;
    collapsed: boolean;
    onSelect: (i: number) => void;
    onToggle: () => void;
  }) => (
    <div
      data-testid="doc-list"
      data-current={currentIndex}
      data-collapsed={String(collapsed)}
    >
      <button data-testid="select-1" onClick={() => onSelect(1)}>
        sel
      </button>
      <button data-testid="toggle" onClick={onToggle}>
        toggle
      </button>
    </div>
  ),
}));

import { ArbitrationPageContent } from "../ArbitrationPageContent";
import type { ArbitrationDoc } from "../ArbitrationPage";

afterEach(cleanup);

const doc: ArbitrationDoc = {
  docId: "d1",
  title: "Doc 1",
  externalId: null,
  text: "TEXTO DO DOCUMENTO",
  fields: [
    {
      fieldReviewId: "f1",
      fieldName: "q1",
      aAnswer: "a",
      bAnswer: "b",
      blindVerdict: null,
      reveal: null,
    },
  ],
};

type Props = Parameters<typeof ArbitrationPageContent>[0];

function renderContent(over: Partial<Props> = {}) {
  const props: Props = {
    doc,
    fieldMeta: new Map(),
    phase: "blind",
    arbitrationBlind: false,
    docListEntries: [],
    docIndex: 2,
    listCollapsed: false,
    onSelectDoc: vi.fn(),
    onToggleList: vi.fn(),
    blindChoices: {},
    finalChoices: {},
    suggestions: {},
    comments: {},
    onChooseBlind: vi.fn(),
    onChooseFinal: vi.fn(),
    onSuggestion: vi.fn(),
    onComment: vi.fn(),
    ...over,
  };
  render(<ArbitrationPageContent {...props} />);
  return props;
}

describe("ArbitrationPageContent", () => {
  it("renderiza o leitor de documento com o texto do doc", () => {
    renderContent();
    expect(screen.getByTestId("doc-reader").textContent).toBe(
      "TEXTO DO DOCUMENTO",
    );
  });

  it("fase blind: renderiza BlindPhase (não RevealPhase) e a dica da fase 1", () => {
    renderContent({ phase: "blind" });
    expect(screen.getByTestId("blind-phase")).toBeTruthy();
    expect(screen.queryByTestId("reveal-phase")).toBeNull();
    expect(screen.getByText(/Fase 1 \(cega\)/)).toBeTruthy();
  });

  it("fase reveal: renderiza RevealPhase (não BlindPhase) e a dica da fase 2", () => {
    renderContent({ phase: "reveal" });
    expect(screen.getByTestId("reveal-phase")).toBeTruthy();
    expect(screen.queryByTestId("blind-phase")).toBeNull();
    expect(screen.getByText(/Fase 2/)).toBeTruthy();
  });

  it("repassa onChooseBlind ao BlindPhase", () => {
    const props = renderContent({ phase: "blind" });
    fireEvent.click(screen.getByTestId("blind-phase"));
    expect(props.onChooseBlind).toHaveBeenCalledWith("f1", "a");
  });

  it("repassa onChooseFinal ao RevealPhase", () => {
    const props = renderContent({ phase: "reveal" });
    fireEvent.click(screen.getByTestId("reveal-phase"));
    expect(props.onChooseFinal).toHaveBeenCalledWith("f1", "llm");
  });

  it("encaminha índice/colapso e os callbacks à sidebar", () => {
    const props = renderContent({ docIndex: 2, listCollapsed: true });
    const list = screen.getByTestId("doc-list");
    expect(list.getAttribute("data-current")).toBe("2");
    expect(list.getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(screen.getByTestId("select-1"));
    expect(props.onSelectDoc).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByTestId("toggle"));
    expect(props.onToggleList).toHaveBeenCalledTimes(1);
  });
});
