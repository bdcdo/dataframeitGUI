// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mocks dos Server Actions e do toast (efeitos colaterais fora do escopo do
// teste de lógica do container).
const { submitVerdict, markCompareDocReviewed } = vi.hoisted(() => ({
  submitVerdict: vi.fn<
    (...args: unknown[]) => Promise<{ error?: string } | void>
  >(async () => {}),
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/analyze/compare",
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
  pendingVerdict: PendingVerdict | null;
  onPrepareVerdict: (pending: PendingVerdict) => void;
  onConfirmPendingVerdict: () => void;
  isConfirmingVerdict: boolean;
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
      <span data-testid="pending-verdict">
        {comparisonPanel.pendingVerdict
          ? pendingVerdictLabel(comparisonPanel.pendingVerdict)
          : ""}
      </span>
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
        data-testid="prepare-verdict"
        onClick={() =>
          comparisonPanel.onPrepareVerdict({
            kind: "response",
            verdict: "Deferido",
            chosenResponseId: "r1",
          })
        }
      >
        prepare verdict
      </button>
      <button
        data-testid="prepare-verdict-2"
        onClick={() =>
          comparisonPanel.onPrepareVerdict({
            kind: "response",
            verdict: "Indeferido",
            chosenResponseId: "r2",
          })
        }
      >
        prepare verdict 2
      </button>
      <button
        data-testid="confirm-verdict"
        disabled={comparisonPanel.isConfirmingVerdict}
        onClick={() => comparisonPanel.onConfirmPendingVerdict()}
      >
        {comparisonPanel.isConfirmingVerdict ? "saving verdict" : "confirm verdict"}
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
import { pendingVerdictLabel, type CompareResponse, type PendingVerdict } from "@/components/compare/compare-types";

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
    isCoordinator: false,
    showingAllQueue: false,
    hasAssignedDocs: false,
    isImpersonating: false,
  };
}

const text = (id: string) => screen.getByTestId(id).textContent;
const commentInput = () => screen.getByTestId("comment") as HTMLInputElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
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

    await user.click(screen.getByTestId("prepare-verdict"));
    expect(submitVerdict).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("confirm-verdict"));

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

  it("número prepara veredito do grupo correspondente; Enter confirma", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    // campoA: grupos [Deferido(r1), Indeferido(r2)] → '2' escolhe Indeferido.
    await user.keyboard("2");

    expect(submitVerdict).not.toHaveBeenCalled();
    expect(text("pending-verdict")).toBe("Indeferido");

    await user.keyboard("{Enter}");

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

  it("teclas 'a' e 's' preparam marcadores especiais; Enter confirma", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.keyboard("a");
    expect(submitVerdict).not.toHaveBeenCalled();
    expect(text("pending-verdict")).toBe("Ambíguo");

    await user.keyboard("s");
    expect(submitVerdict).not.toHaveBeenCalled();
    expect(text("pending-verdict")).toBe("Pular");

    await user.keyboard("{Enter}");
    expect(submitVerdict).toHaveBeenCalledWith(
      "p1",
      "d1",
      "campoA",
      "pular",
      undefined,
      undefined,
      expect.any(Array),
    );
  });

  it("teclas 'a' e 's' em campo multi salvam marcadores especiais diretamente", async () => {
    const user = userEvent.setup();
    render(
      <ComparePage
        {...makeProps()}
        fields={[
          {
            name: "campoA",
            type: "multi",
            options: ["Sim", "Não"],
            description: "Campo A",
            hash: "hA",
          } as PydanticField,
          fields[1],
        ]}
        divergentFields={{ d1: ["campoA"], d2: ["campoA"] }}
      />,
    );

    await user.keyboard("a");
    await user.keyboard("s");

    expect(submitVerdict).toHaveBeenNthCalledWith(
      1,
      "p1",
      "d1",
      "campoA",
      "ambiguo",
      undefined,
      undefined,
      expect.any(Array),
    );
    expect(submitVerdict).toHaveBeenNthCalledWith(
      2,
      "p1",
      "d1",
      "campoA",
      "pular",
      undefined,
      undefined,
      expect.any(Array),
    );
  });

  it("campo multi trava a segunda tecla especial enquanto o salvamento está em andamento", async () => {
    const save = deferred<void>();
    submitVerdict.mockReturnValueOnce(save.promise);
    const user = userEvent.setup();
    render(
      <ComparePage
        {...makeProps()}
        fields={[
          {
            name: "campoA",
            type: "multi",
            options: ["Sim", "Não"],
            description: "Campo A",
            hash: "hA",
          } as PydanticField,
          fields[1],
        ]}
        divergentFields={{ d1: ["campoA"], d2: ["campoA"] }}
      />,
    );

    // 'a' inicia um save em voo; 's' logo em seguida é ignorado — sem disparar
    // um segundo submitVerdict concorrente para o mesmo campo.
    await user.keyboard("a");
    await user.keyboard("s");

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(submitVerdict).toHaveBeenNthCalledWith(
      1,
      "p1",
      "d1",
      "campoA",
      "ambiguo",
      undefined,
      undefined,
      expect.any(Array),
    );

    save.resolve(undefined);
    await waitFor(() => expect(submitVerdict).toHaveBeenCalledTimes(1));
  });

  it("o comentário digitado segue junto no veredito por teclado", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.type(commentInput(), "minha nota");
    // Atalhos ficam desativados com foco no input; sair do campo reabilita.
    commentInput().blur();

    await user.keyboard("1");
    expect(submitVerdict).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");

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

  it("documento concluído permite preparar correção por teclado e só salva no Enter", async () => {
    const user = userEvent.setup();
    render(
      <ComparePage
        {...makeProps({
          d1: { campoA: verdict("Deferido"), campoB: verdict("Sim") },
        })}
      />,
    );

    await user.keyboard("2");

    expect(submitVerdict).not.toHaveBeenCalled();
    expect(text("pending-verdict")).toBe("Indeferido");

    await user.keyboard("{Enter}");

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

    await user.click(screen.getByTestId("prepare-verdict"));
    expect(submitVerdict).not.toHaveBeenCalled();
    expect(text("pending-verdict")).toBe("Deferido");

    await user.click(screen.getByTestId("confirm-verdict"));

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

  it("falha de salvamento mantém o pendente e não avança o campo", async () => {
    submitVerdict.mockResolvedValueOnce({ error: "falha ao salvar" });
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("prepare-verdict"));
    expect(text("pending-verdict")).toBe("Deferido");

    await user.click(screen.getByTestId("confirm-verdict"));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(text("field-name")).toBe("campoA");
    expect(text("pending-verdict")).toBe("Deferido");
  });

  it("trocar de campo limpa o pendente e não salva o veredito antigo no novo contexto", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("prepare-verdict"));
    expect(text("pending-verdict")).toBe("Deferido");

    await user.click(screen.getByTestId("next-field"));
    expect(text("field-name")).toBe("campoB");
    expect(text("pending-verdict")).toBe("");

    await user.click(screen.getByTestId("confirm-verdict"));
    expect(submitVerdict).not.toHaveBeenCalled();
  });

  it("bloqueia confirmação dupla e navegação enquanto o salvamento está em andamento", async () => {
    const save = deferred<void>();
    submitVerdict.mockReturnValueOnce(save.promise);
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("prepare-verdict"));
    await user.click(screen.getByTestId("confirm-verdict"));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("confirm-verdict")).toHaveProperty("disabled", true);

    await user.click(screen.getByTestId("confirm-verdict"));
    await user.click(screen.getByTestId("next-field"));
    await user.click(screen.getByTestId("nav-next-doc"));
    await user.keyboard("n");

    // Re-preparar durante o save é ignorado: o rascunho em voo (Deferido)
    // continua, sem ser trocado por Indeferido e depois descartado em silêncio.
    await user.click(screen.getByTestId("prepare-verdict-2"));
    expect(text("pending-verdict")).toBe("Deferido");

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(text("field-name")).toBe("campoA");
    expect(text("doc-text")).toBe("Texto do documento 1");

    save.resolve(undefined);
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

// Antes deste PR, nenhum teste deste arquivo exercitava isCoordinator: true —
// a bar do toggle e a diferenciação da mensagem de estado vazio ficavam sem
// cobertura direta.
describe("ComparePage — toggle de fila (só coordenador)", () => {
  function emptyProps(overrides: Partial<ReturnType<typeof makeProps>> = {}) {
    return {
      ...makeProps(),
      documents: [],
      divergentFields: {},
      responses: {},
      coverageByDoc: {},
      ...overrides,
    };
  }

  it("não-coordenador nunca vê o toggle de fila", () => {
    render(<ComparePage {...emptyProps({ isCoordinator: false })} />);
    expect(screen.queryByRole("tab", { name: "Meus atribuídos" })).toBeNull();
  });

  it("coordenador vê o toggle de fila", () => {
    render(<ComparePage {...emptyProps({ isCoordinator: true })} />);
    expect(screen.getByRole("tab", { name: "Meus atribuídos" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Todos" })).not.toBeNull();
  });

  it("sem nenhum documento atribuído: mensagem sugere a aba 'Todos'", () => {
    render(
      <ComparePage
        {...emptyProps({
          isCoordinator: true,
          showingAllQueue: false,
          hasAssignedDocs: false,
        })}
      />,
    );
    expect(
      screen.getByText(/Você não tem documentos atribuídos.*aba "Todos"/),
    ).not.toBeNull();
  });

  it("com documentos atribuídos filtrados por cobertura: mensagem não sugere trocar de aba", () => {
    render(
      <ComparePage
        {...emptyProps({
          isCoordinator: true,
          showingAllQueue: false,
          hasAssignedDocs: true,
        })}
      />,
    );
    expect(
      screen.getByText(/não atendem aos filtros atuais/),
    ).not.toBeNull();
    expect(
      screen.queryByText(/Você não tem documentos atribuídos/),
    ).toBeNull();
  });

  it("impersonando sem documentos atribuídos: copy em 3ª pessoa (fila é do membro)", () => {
    render(
      <ComparePage
        {...emptyProps({
          isCoordinator: true,
          showingAllQueue: false,
          hasAssignedDocs: false,
          isImpersonating: true,
        })}
      />,
    );
    expect(
      screen.getByText(/Este membro não tem documentos atribuídos.*aba "Todos"/),
    ).not.toBeNull();
    expect(
      screen.queryByText(/Você não tem documentos atribuídos/),
    ).toBeNull();
  });

  it("impersonando com atribuídos filtrados por cobertura: copy em 3ª pessoa", () => {
    render(
      <ComparePage
        {...emptyProps({
          isCoordinator: true,
          showingAllQueue: false,
          hasAssignedDocs: true,
          isImpersonating: true,
        })}
      />,
    );
    expect(
      screen.getByText(/atribuídos a este membro não atendem aos filtros atuais/),
    ).not.toBeNull();
    expect(screen.queryByText(/Seus documentos atribuídos/)).toBeNull();
  });

  it("na aba 'Todos', a mensagem genérica não menciona assignment", () => {
    render(
      <ComparePage
        {...emptyProps({ isCoordinator: true, showingAllQueue: true })}
      />,
    );
    expect(
      screen.getByText("Nenhum documento na fila com os filtros atuais."),
    ).not.toBeNull();
  });
});
