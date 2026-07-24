// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

const { refresh, submitBlindVerdicts, submitFinalVerdicts } = vi.hoisted(
  () => ({
    refresh: vi.fn(),
    submitBlindVerdicts: vi.fn(),
    submitFinalVerdicts: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/actions/field-reviews", () => ({
  submitBlindVerdicts,
  submitFinalVerdicts,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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

import { ArbitrationPage } from "../ArbitrationPage";
import type {
  ArbitrationDoc,
  ArbitrationField,
  ArbitrationPageProps,
} from "../ArbitrationPage";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

function field(
  fieldReviewId: string,
  blindVerdict: ArbitrationVerdict | null,
): ArbitrationField {
  return {
    fieldReviewId,
    fieldName: fieldReviewId,
    aAnswer: "a",
    bAnswer: "b",
    blindVerdict,
    reveal:
      blindVerdict === null
        ? null
        : {
            aSide: "humano",
            bSide: "llm",
            humanName: "Ana",
            llmName: "GPT",
            llmJustification: "j-llm",
            selfJustification: "j-hum",
          },
  };
}

function doc(docId: string, fields: ArbitrationField[], text: string): ArbitrationDoc {
  return { docId, title: docId, externalId: null, text, fields };
}

const pydField: PydanticField = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "f1",
  type: "single",
  options: null,
  description: "d",
};

function renderPage(over: Partial<ArbitrationPageProps> = {}) {
  const props: ArbitrationPageProps = {
    projectId: "p1",
    projectName: "Projeto",
    fields: [pydField],
    docs: [],
    arbitrationBlind: false,
    ...over,
  };
  render(<ArbitrationPage {...props} />);
  return props;
}

describe("ArbitrationPage — integração", () => {
  it("sem documentos, mostra o estado vazio", () => {
    renderPage({ docs: [] });
    expect(screen.getByText(/Nenhuma arbitragem pendente/)).toBeTruthy();
    expect(screen.queryByText("Arbitragem humano vs LLM")).toBeNull();
  });

  it("doc com algum verdict pendente entra na fase cega", () => {
    renderPage({
      docs: [doc("d1", [field("f1", null), field("f2", "humano")], "txt-d1")],
    });
    // "Cega" aparece no badge do header e no badge da sidebar.
    expect(screen.getAllByText("Cega").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Avançar para revelação" }),
    ).toBeTruthy();
    // BlindPhase renderizou (rótulos das opções A/B).
    expect(screen.getAllByText("Resposta A").length).toBeGreaterThan(0);
  });

  it("doc com todos os verdicts cegos entra na fase de revelação", () => {
    renderPage({
      docs: [doc("d1", [field("f1", "humano")], "txt-d1")],
    });
    // "Revelação" aparece no badge do header e no badge da sidebar.
    expect(screen.getAllByText("Revelação").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Enviar arbitragem" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Humano acertou" }),
    ).toBeTruthy();
  });

  it("mostra a contagem de documentos e o texto do doc atual", () => {
    renderPage({
      docs: [
        doc("d1", [field("f1", null)], "texto um"),
        doc("d2", [field("f1", null)], "texto dois"),
      ],
    });
    expect(screen.getByText("2 docs")).toBeTruthy();
    expect(screen.getByTestId("doc-reader").textContent).toBe("texto um");
  });

  it("navegar para o próximo doc troca o conteúdo e persiste o pin", () => {
    renderPage({
      docs: [
        doc("d1", [field("f1", null)], "texto um"),
        doc("d2", [field("f1", null)], "texto dois"),
      ],
    });
    fireEvent.click(screen.getByTitle("Próximo documento"));
    expect(screen.getByTestId("doc-reader").textContent).toBe("texto dois");
    expect(sessionStorage.getItem("arbitration:docId:p1")).toBe("d2");
  });

  it("restaura o doc fixado do sessionStorage no primeiro render", () => {
    sessionStorage.setItem("arbitration:docId:p1", "d2");
    renderPage({
      docs: [
        doc("d1", [field("f1", null)], "texto um"),
        doc("d2", [field("f1", null)], "texto dois"),
      ],
    });
    expect(screen.getByTestId("doc-reader").textContent).toBe("texto dois");
    expect(screen.getByText("2/2")).toBeTruthy();
  });
});
