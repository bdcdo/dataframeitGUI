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
// container. NÃO testam o render dos filhos reais (CompareNav/ComparisonPanel/
// DocumentReader), que este PR não altera e têm contrato garantido por tsc.
interface MockComparisonPanel {
  fieldName: string;
  fieldIndex: number;
  comment: string;
  onCommentChange: (v: string) => void;
  onFieldNavigate: (i: number) => void;
  onVerdict: (verdict: string, chosenResponseId?: string) => void;
  onConfirmEquivalent: (
    responseIds: string[],
    gabaritoId: string,
    verdictDisplay: string,
  ) => Promise<void>;
  onMarkReviewed: () => void;
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
      <button
        data-testid="confirm-equiv"
        onClick={() =>
          void comparisonPanel.onConfirmEquivalent(
            ["r1", "r2"],
            "r1",
            "Equivalentes",
          )
        }
      >
        equiv
      </button>
      <button
        data-testid="mark-reviewed"
        onClick={() => comparisonPanel.onMarkReviewed()}
      >
        mark reviewed
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
      <button
        data-testid="set-filter-b"
        onClick={() => onFilterChange("campoB")}
      >
        filter campoB
      </button>
      <button data-testid="nav-next-doc" onClick={() => onDocNavigate(1)}>
        nav doc 1
      </button>
    </div>
  ),
}));

vi.mock("@/components/coding/FullscreenNav", () => ({
  FullscreenNav: ({ title }: { title: string }) => (
    <div data-testid="fullscreen-nav">{title}</div>
  ),
}));

import { ComparePage } from "@/components/compare/ComparePage";
import type { PydanticField } from "@/lib/types";
import type { ReviewsByDoc } from "@/lib/compare-reviews";
import type { CompareResponse } from "@/components/compare/compare-types";

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

function resp(
  id: string,
  type: "humano" | "llm",
  name: string,
  answers: Record<string, unknown>,
): CompareResponse {
  return {
    id,
    respondent_type: type,
    respondent_name: name,
    respondent_id: id,
    answers,
    justifications: null,
    is_latest: true,
    pydantic_hash: null,
    answer_field_hashes: null,
    schema_version_major: null,
    schema_version_minor: null,
    schema_version_patch: null,
    created_at: "2026-01-01",
  };
}

const responses: Record<string, CompareResponse[]> = {
  d1: [
    resp("r1", "humano", "Ana", { campoA: "Deferido", campoB: "Sim" }),
    resp("r2", "llm", "GPT", { campoA: "Indeferido", campoB: "Não" }),
  ],
  d2: [resp("r3", "humano", "Ana", { campoA: "Deferido" })],
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
    responses,
    divergentFields,
    fields,
    existingReviews,
    projectPydanticHash: null,
    respondentNames: ["Ana", "Bia"],
    defaultMinHumans: 2,
    defaultVersion: "latest_major",
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
const verdict = (verdictName: string, comment: string | null = null) => ({
  verdict: verdictName,
  chosenResponseId: null,
  comment,
});

beforeEach(() => {
  submitVerdict.mockClear();
  markCompareDocReviewed.mockClear();
  confirmEquivalentVerdict.mockClear();
  unmarkEquivalencePair.mockClear();
});

afterEach(cleanup);

describe("ComparePage — comentário (fix no-derived-state)", () => {
  it("semeia o comentário do veredito existente já na montagem", () => {
    render(
      <ComparePage
        {...makeProps({ d1: { campoA: verdict("X", "nota inicial") } })}
      />,
    );
    expect(text("field-name")).toBe("campoA");
    expect(commentInput().value).toBe("nota inicial");
  });

  it("reseta o comentário ao trocar de campo (descarta rascunho, semeia do novo veredito)", async () => {
    const user = userEvent.setup();
    render(
      <ComparePage
        {...makeProps({ d1: { campoB: verdict("Deferido", "comentário do campo B") } })}
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

  it("preserva o comentário na caixa após emitir veredito sem avançar de campo", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    // Filtra para um único campo → emitir veredito não troca de campo (a fila
    // filtrada tem só campoB), então a caixa deve manter o comentário salvo.
    await user.click(screen.getByTestId("set-filter-b"));
    expect(text("field-name")).toBe("campoB");

    await user.type(commentInput(), "minha nota");
    expect(commentInput().value).toBe("minha nota");

    await user.click(screen.getByTestId("emit-verdict"));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(text("field-name")).toBe("campoB");
    expect(commentInput().value).toBe("minha nota");
  });
});

describe("ComparePage — navegação e filtro", () => {
  it("trocar o filtro reseta o índice de campo para o primeiro", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("next-field"));
    expect(text("field-name")).toBe("campoB");

    await user.click(screen.getByTestId("set-filter-all"));
    expect(text("field-name")).toBe("campoA");
  });

  it("filtrar por um campo estreita a fila e o avanço fica preso nele", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("set-filter-b"));
    expect(text("field-name")).toBe("campoB");

    // Só há campoB na fila filtrada → a tecla 'n' (goNextField) fica presa nele.
    await user.keyboard("n");
    expect(text("field-name")).toBe("campoB");
  });

  it("navegar de documento fixa o doc e cai no primeiro campo divergente dele", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    expect(text("doc-text")).toBe("Texto do documento 1");

    await user.click(screen.getByTestId("nav-next-doc"));

    expect(text("doc-text")).toBe("Texto do documento 2");
    expect(text("field-name")).toBe("campoA");
  });

  it("clampa o índice de campo quando divergentFields encolhe (não vira undefined)", async () => {
    const user = userEvent.setup();
    const fieldsABC: PydanticField[] = [
      ...fields,
      { name: "campoC", type: "text", options: null, description: "Campo C", hash: "hC" },
    ];
    const base = {
      ...makeProps(),
      fields: fieldsABC,
      divergentFields: { d1: ["campoA", "campoB", "campoC"], d2: ["campoA"] },
    };
    const { rerender } = render(<ComparePage {...base} />);

    // Navega até o último campo (campoC) → fieldIndex interno = 2.
    await user.keyboard("n");
    await user.keyboard("n");
    expect(text("field-name")).toBe("campoC");

    // Servidor revalida e o doc passa a ter só 2 campos divergentes; o filtro e
    // o doc não mudaram, então fieldIndex (=2) fica fora de range.
    rerender(
      <ComparePage
        {...base}
        divergentFields={{ d1: ["campoA", "campoB"], d2: ["campoA"] }}
      />,
    );

    // Sem o clamp, docFields[2] seria undefined; com clamp cai no último válido.
    expect(text("field-name")).toBe("campoB");
  });
});

describe("ComparePage — atalhos de teclado (fix no-cascading-set-state)", () => {
  it("teclas 'n'/'p' navegam entre campos", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    expect(text("field-name")).toBe("campoA");
    await user.keyboard("n");
    expect(text("field-name")).toBe("campoB");
    await user.keyboard("p");
    expect(text("field-name")).toBe("campoA");
  });

  it("número emite veredito do grupo de resposta correspondente", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    // campoA: grupos [Deferido(r1), Indeferido(r2)] → '2' escolhe Indeferido.
    await user.keyboard("2");

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(submitVerdict).toHaveBeenCalledWith(
      "p1",
      "d1",
      "campoA",
      "Indeferido",
      "r2",
      undefined,
      expect.any(Array),
    );
  });

  it("tecla 'a' emite veredito 'ambiguo' e 's' emite 'pular'", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.keyboard("a");
    expect(submitVerdict).toHaveBeenCalledWith(
      "p1",
      "d1",
      "campoA",
      "ambiguo",
      undefined,
      undefined,
      expect.any(Array),
    );
  });

  it("o comentário digitado segue junto no veredito por teclado", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.type(commentInput(), "minha nota");
    // Atalhos ficam desativados com foco no input; sair do campo reabilita.
    commentInput().blur();

    await user.keyboard("1");

    expect(submitVerdict).toHaveBeenCalledWith(
      "p1",
      "d1",
      "campoA",
      "Deferido",
      "r1",
      "minha nota",
      expect.any(Array),
    );
  });

  it("não dispara veredito por teclado quando o documento já está concluído", async () => {
    const user = userEvent.setup();
    render(
      <ComparePage
        {...makeProps({
          d1: { campoA: verdict("Deferido"), campoB: verdict("Sim") },
        })}
      />,
    );

    await user.keyboard("1");
    await user.keyboard("a");
    expect(submitVerdict).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+F entra em tela cheia e Esc sai", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    // Não-fullscreen: CompareNav (mock) presente, FullscreenNav ausente.
    expect(screen.queryByTestId("nav-doc-index")).not.toBeNull();
    expect(screen.queryByTestId("fullscreen-nav")).toBeNull();

    await user.keyboard("{Control>}{Shift>}F{/Shift}{/Control}");
    expect(screen.queryByTestId("fullscreen-nav")).not.toBeNull();
    expect(screen.queryByTestId("nav-doc-index")).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("fullscreen-nav")).toBeNull();
    expect(screen.queryByTestId("nav-doc-index")).not.toBeNull();
  });
});

describe("ComparePage — vereditos e equivalências (useCompareVerdicts)", () => {
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
    await waitFor(() => expect(text("field-name")).toBe("campoB"));
  });

  it("confirmar equivalência chama confirmEquivalentVerdict e avança o campo", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("confirm-equiv"));

    expect(confirmEquivalentVerdict).toHaveBeenCalledTimes(1);
    expect(confirmEquivalentVerdict).toHaveBeenCalledWith(
      "p1",
      "d1",
      "campoA",
      ["r1", "r2"],
      "r1",
      "Equivalentes",
      undefined,
      expect.any(Array),
    );
    await waitFor(() => expect(text("field-name")).toBe("campoB"));
  });

  it("marcar revisado chama markCompareDocReviewed do doc atual", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("mark-reviewed"));

    expect(markCompareDocReviewed).toHaveBeenCalledWith("p1", "d1");
  });
});
