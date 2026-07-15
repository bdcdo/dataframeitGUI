// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";

// Smoke de ÁRVORE REAL: renderiza os filhos reais (CompareNav, ComparisonPanel,
// CompareWorkspace) para garantir que o container os monta com props válidas e
// que um veredito confirmado no painel real chega ao Server Action. Só o
// DocumentReader é mockado (usa react-markdown via next/dynamic, ruidoso em
// jsdom e irrelevante para esta verificação).
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
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/components/coding/DocumentReader", () => ({
  DocumentReader: ({ text }: { text: string }) => (
    <div data-testid="doc-reader">{text}</div>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/analyze/compare",
}));
// A árvore real monta RunCard, que usa useAuth().getToken para anexar o JWT.
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn(async () => "test-token") }),
}));

import { toast } from "sonner";
import { ComparePage } from "@/components/compare/ComparePage";
import type { PydanticField } from "@/lib/types";
import type { CompareResponse } from "@/components/compare/compare-types";

const fields: PydanticField[] = [
  { name: "campoA", type: "text", options: null, description: "Pergunta A", hash: "hA" },
  { name: "campoB", type: "text", options: null, description: "Pergunta B", hash: "hB" },
];

const documents = [
  { id: "d1", title: "Doc 1", external_id: null, text: "Texto do documento 1" },
];

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

const props = {
  projectId: "p1",
  documents,
  responses: {
    d1: [
      resp("r1", "humano", "Ana", { campoA: "Deferido", campoB: "Sim" }),
      resp("r2", "llm", "GPT", { campoA: "Indeferido", campoB: "Não" }),
    ],
  },
  divergentFields: { d1: ["campoA", "campoB"] },
  fields,
  existingReviews: {},
  projectPydanticHash: null,
  respondentNames: ["Ana", "GPT"],
  defaultMinHumans: 2,
  defaultVersion: "latest_major",
  coverageByDoc: {
    d1: {
      docId: "d1",
      humanCount: 1,
      totalCount: 2,
      assignedCodingCount: 1,
      humansFromAssigned: 1,
      divergentCount: 2,
      reviewedCount: 0,
      assignmentStatus: null,
    },
  },
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

const canonicalEquivalence = {
  d1: {
    campoA: [
      {
        id: "eq-canonical",
        response_a_id: "r1",
        response_b_id: "r2",
        reviewer_id: "canonical-reviewer",
      },
    ],
  },
};

const renderReal = () =>
  render(
    <TooltipProvider>
      <ComparePage {...props} />
    </TooltipProvider>,
  );

// jsdom não tem ResizeObserver — exigido por react-resizable-panels.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// Radix (Popover do CompareFilters) usa APIs de Pointer que o jsdom não tem.
{
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView = () => {};
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
}

beforeEach(() => {
  submitVerdict.mockClear();
  unmarkEquivalencePair.mockClear();
  vi.mocked(toast.warning).mockClear();
});
afterEach(cleanup);

describe("ComparePage — árvore real (smoke)", () => {
  it("monta os filhos reais e exibe o texto do documento e as respostas", () => {
    renderReal();
    expect(screen.getByTestId("doc-reader").textContent).toBe(
      "Texto do documento 1",
    );
    // O ComparisonPanel real renderiza as respostas divergentes do campo atual.
    expect(screen.getByText("Deferido")).not.toBeNull();
    expect(screen.getByText("Indeferido")).not.toBeNull();
  });

  it("clicar 'Ambíguo' no painel real só dispara submitVerdict ao confirmar", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.click(screen.getByRole("button", { name: /Ambíguo/i }));

    expect(submitVerdict).not.toHaveBeenCalled();
    expect(screen.getByText("Selecionado:")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
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

  it("'Descartar' no painel real limpa a seleção sem salvar", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.click(screen.getByRole("button", { name: /Ambíguo/i }));
    expect(screen.getByText("Selecionado:")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Descartar" }));

    expect(screen.queryByText("Selecionado:")).toBeNull();
    expect(screen.queryByRole("button", { name: "Descartar" })).toBeNull();
    expect(submitVerdict).not.toHaveBeenCalled();
  });

  it("com rascunho pendente, trocar filtro de fila no popover real é bloqueado com aviso", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.click(screen.getByRole("button", { name: /Ambíguo/i }));
    expect(screen.getByText("Selecionado:")).not.toBeNull();

    // Vetor da revisão do PR #434: CompareFilters faz o próprio push de URL e
    // recompõe a fila — sem o gate, o rascunho seria descartado em silêncio
    // pelo guard de contexto (mesma classe do incidente do #430).
    await user.click(screen.getByRole("button", { name: /Filtros/i }));
    const dateInput = document.querySelector('input[type="date"]');
    expect(dateInput).not.toBeNull();
    fireEvent.change(dateInput as HTMLInputElement, {
      target: { value: "2026-01-01" },
    });

    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      "Seleção não confirmada — confirme ou descarte antes de avançar.",
      { id: "compare-nav-guard" },
    );
    // Rascunho intacto e filtro não aplicado (input controlado volta a vazio).
    expect(screen.getByText("Selecionado:")).not.toBeNull();
    expect((dateInput as HTMLInputElement).value).toBe("");
  });

  it("coordenador vê o toggle de fila real (CompareQueueTabs) montado", () => {
    render(
      <TooltipProvider>
        <ComparePage {...props} isCoordinator canManageAnyPair />
      </TooltipProvider>,
    );
    expect(screen.getByRole("tab", { name: "Meus atribuídos" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Todos" })).not.toBeNull();
  });

  it("conta-alias pesquisadora desfaz o par persistido sob sua identidade canônica", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ComparePage
          {...props}
          currentUserId="canonical-reviewer"
          equivalencesByDocField={canonicalEquivalence}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /1 variante/i }));
    await user.click(
      await screen.findByRole("button", { name: "Desfazer equivalência" }),
    );

    await waitFor(() =>
      expect(unmarkEquivalencePair).toHaveBeenCalledWith("p1", "eq-canonical"),
    );
  });

  it("outro pesquisador não vê o controle para desfazer o par canônico", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ComparePage
          {...props}
          currentUserId="other-researcher"
          equivalencesByDocField={canonicalEquivalence}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: /1 variante/i }));

    expect(
      screen.queryByRole("button", { name: "Desfazer equivalência" }),
    ).toBeNull();
    expect(unmarkEquivalencePair).not.toHaveBeenCalled();
  });
});
