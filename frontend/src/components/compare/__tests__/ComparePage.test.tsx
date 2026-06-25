// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mocks dos Server Actions e do toast (efeitos colaterais fora do escopo do
// teste de lógica do container).
const { submitVerdict, markCompareDocReviewed } = vi.hoisted(() => ({
  submitVerdict: vi.fn(async () => {}),
  markCompareDocReviewed: vi.fn(async () => {}),
}));
const { confirmEquivalentVerdict, unmarkEquivalencePair } = vi.hoisted(() => ({
  confirmEquivalentVerdict: vi.fn(async () => {}),
  unmarkEquivalencePair: vi.fn(async () => {}),
}));

vi.mock("@/actions/reviews", () => ({ submitVerdict, markCompareDocReviewed }));
vi.mock("@/actions/equivalences", () => ({
  confirmEquivalentVerdict,
  unmarkEquivalencePair,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Mock das views: expõem só os controles necessários para dirigir a lógica do
// container (input de comentário, troca de campo/doc, emissão de veredito).
interface MockComparisonPanel {
  fieldName: string;
  fieldIndex: number;
  comment: string;
  onCommentChange: (v: string) => void;
  onFieldNavigate: (i: number) => void;
  onVerdict: (verdict: string, chosenResponseId?: string) => void;
}

vi.mock("@/components/compare/CompareWorkspace", () => ({
  CompareWorkspace: ({
    documentText,
    comparisonPanel,
  }: {
    documentText: string;
    comparisonPanel: MockComparisonPanel;
  }) => (
    <div>
      <span data-testid="doc-text">{documentText}</span>
      <span data-testid="field-name">{comparisonPanel.fieldName}</span>
      <input
        data-testid="comment"
        value={comparisonPanel.comment}
        onChange={(e) => comparisonPanel.onCommentChange(e.target.value)}
      />
      <button
        data-testid="next-field"
        onClick={() =>
          comparisonPanel.onFieldNavigate(comparisonPanel.fieldIndex + 1)
        }
      >
        next field
      </button>
      <button
        data-testid="emit-verdict"
        onClick={() => comparisonPanel.onVerdict("Deferido", "r1")}
      >
        verdict
      </button>
    </div>
  ),
}));

vi.mock("@/components/compare/CompareNav", () => ({
  CompareNav: ({
    docIndex,
    onFilterChange,
    onDocNavigate,
  }: {
    docIndex: number;
    onFilterChange: (v: string) => void;
    onDocNavigate: (i: number) => void;
  }) => (
    <div>
      <span data-testid="nav-doc-index">{docIndex}</span>
      <button data-testid="set-filter-all" onClick={() => onFilterChange("all")}>
        filter all
      </button>
      <button data-testid="nav-next-doc" onClick={() => onDocNavigate(1)}>
        nav doc 1
      </button>
    </div>
  ),
}));

import { ComparePage } from "@/components/compare/ComparePage";
import type { PydanticField } from "@/lib/types";
import type { ReviewsByDoc } from "@/lib/compare-reviews";

const fields: PydanticField[] = [
  { name: "campoA", type: "text", options: null, description: "Campo A", hash: "hA" },
  { name: "campoB", type: "text", options: null, description: "Campo B", hash: "hB" },
];

const documents = [
  { id: "d1", title: "Doc 1", external_id: null, text: "Texto do documento 1" },
  { id: "d2", title: "Doc 2", external_id: null, text: "Texto do documento 2" },
];

const divergentFields: Record<string, string[]> = {
  d1: ["campoA", "campoB"],
  d2: ["campoA"],
};

const coverage = (docId: string) => ({
  docId,
  humanCount: 2,
  totalCount: 2,
  assignedCodingCount: 2,
  humansFromAssigned: 2,
  divergentCount: divergentFields[docId].length,
  reviewedCount: 0,
  assignmentStatus: null,
});

function makeProps(existingReviews: ReviewsByDoc = {}) {
  return {
    projectId: "p1",
    documents,
    responses: { d1: [], d2: [] },
    divergentFields,
    fields,
    existingReviews,
    projectPydanticHash: null,
    respondentNames: ["Ana", "Bia"],
    defaultMinHumans: 2,
    coverageByDoc: { d1: coverage("d1"), d2: coverage("d2") },
    commentCountsByKey: {},
    suggestionCountsByField: {},
    availableVersions: ["1.0.0"],
    latestMajorLabel: null,
    currentProjectVersion: "1.0.0",
    equivalencesByDocField: {},
    currentUserId: "u1",
    canManageAnyPair: false,
  };
}

const text = (id: string) => screen.getByTestId(id).textContent;
const commentInput = () => screen.getByTestId("comment") as HTMLInputElement;

beforeEach(() => {
  submitVerdict.mockClear();
  markCompareDocReviewed.mockClear();
  confirmEquivalentVerdict.mockClear();
  unmarkEquivalencePair.mockClear();
});

afterEach(cleanup);

describe("ComparePage — lógica do container após refatoração", () => {
  it("semeia o comentário do veredito existente já na montagem", () => {
    render(
      <ComparePage
        {...makeProps({
          d1: {
            campoA: {
              verdict: "X",
              chosenResponseId: null,
              comment: "nota inicial",
            },
          },
        })}
      />,
    );
    expect(text("field-name")).toBe("campoA");
    expect(commentInput().value).toBe("nota inicial");
  });

  it("reseta o comentário ao trocar de campo (descarta rascunho, semeia do novo veredito)", async () => {
    const user = userEvent.setup();
    render(
      <ComparePage
        {...makeProps({
          d1: {
            campoB: {
              verdict: "Deferido",
              chosenResponseId: null,
              comment: "comentário do campo B",
            },
          },
        })}
      />,
    );

    expect(text("field-name")).toBe("campoA");
    expect(commentInput().value).toBe("");

    await user.type(commentInput(), "rascunho");
    expect(commentInput().value).toBe("rascunho");

    await user.click(screen.getByTestId("next-field"));

    expect(text("field-name")).toBe("campoB");
    expect(commentInput().value).toBe("comentário do campo B");
  });

  it("trocar o filtro reseta o índice de campo para o primeiro", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("next-field"));
    expect(text("field-name")).toBe("campoB");

    await user.click(screen.getByTestId("set-filter-all"));
    expect(text("field-name")).toBe("campoA");
  });

  it("navegar de documento fixa o doc e cai no primeiro campo divergente dele", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    expect(text("doc-text")).toBe("Texto do documento 1");

    await user.click(screen.getByTestId("nav-next-doc"));

    expect(text("doc-text")).toBe("Texto do documento 2");
    expect(text("field-name")).toBe("campoA");
  });

  it("teclas 'n'/'p' navegam entre campos (atalhos extraídos para useCompareKeyboard)", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    expect(text("field-name")).toBe("campoA");
    await user.keyboard("n");
    expect(text("field-name")).toBe("campoB");
    await user.keyboard("p");
    expect(text("field-name")).toBe("campoA");
  });

  it("emitir veredito chama submitVerdict e avança para o próximo campo", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    expect(text("field-name")).toBe("campoA");

    await user.click(screen.getByTestId("emit-verdict"));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(submitVerdict).toHaveBeenCalledWith(
      "p1",
      "d1",
      "campoA",
      "Deferido",
      "r1",
      undefined,
      expect.any(Array),
    );
    // campoA fechou, campoB ainda pendente → avança para campoB.
    await waitFor(() => expect(text("field-name")).toBe("campoB"));
  });
});
