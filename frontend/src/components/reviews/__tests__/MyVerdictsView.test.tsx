// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

const { push, refresh, getDocumentText, acknowledgeVerdict } = vi.hoisted(
  () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    getDocumentText: vi.fn(),
    acknowledgeVerdict: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => "/projects/p1/reviews/my-verdicts",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/actions/documents", () => ({ getDocumentText }));
vi.mock("@/actions/verdicts", () => ({ acknowledgeVerdict }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
vi.mock("@/components/shared/AddNoteButton", () => ({
  AddNoteButton: () => <div data-testid="add-note" />,
}));

import { MyVerdictsView } from "@/components/reviews/MyVerdictsView";
import type { VerdictItem } from "@/app/(app)/projects/[id]/reviews/my-verdicts/page";

function makeItem(overrides?: Partial<VerdictItem>): VerdictItem {
  return {
    reviewId: "r-" + (overrides?.documentId ?? "d1"),
    documentId: "d1",
    documentTitle: "Documento Um",
    fieldName: "campo",
    fieldDescription: "Descrição do campo",
    fieldType: "text",
    verdict: "sim",
    coordinatorComment: null,
    myAnswer: "sim",
    isCorrect: true,
    responseSnapshot: null,
    acknowledgmentStatus: null,
    acknowledgmentComment: null,
    ...overrides,
  };
}

// Três documentos corretos → filtro default "all" (sem itens pendentes).
const THREE_DOCS: VerdictItem[] = [
  makeItem({ documentId: "d1", documentTitle: "Documento Um" }),
  makeItem({ documentId: "d2", documentTitle: "Documento Dois" }),
  makeItem({ documentId: "d3", documentTitle: "Documento Tres" }),
];

function renderView(items: VerdictItem[]) {
  return render(
    <MyVerdictsView projectId="p1" items={items} fields={[]} userName="João" />,
  );
}

afterEach(cleanup);
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  push.mockReset();
  refresh.mockReset();
  getDocumentText.mockReset();
  getDocumentText.mockResolvedValue({ text: "conteúdo do documento" });
  acknowledgeVerdict.mockReset();
  acknowledgeVerdict.mockResolvedValue({ error: null });
});

describe("MyVerdictsView — navegação e filtro", () => {
  it("mostra estado vazio quando não há itens", () => {
    renderView([]);
    expect(
      screen.getByText(/nenhum veredito encontrado/i),
    ).toBeTruthy();
  });

  it("navega entre documentos com os botões ◂ ▸", async () => {
    const user = userEvent.setup();
    renderView(THREE_DOCS);

    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.getByText("Documento Um")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /próximo documento/i }));
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.getByText("Documento Dois")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: /documento anterior/i }),
    );
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.getByText("Documento Um")).toBeTruthy();
  });

  it("preserva o documento selecionado quando ele sobrevive ao filtro de busca", async () => {
    const user = userEvent.setup();
    renderView(THREE_DOCS);

    await user.click(screen.getByRole("button", { name: /próximo documento/i })); // → Documento Dois
    expect(screen.getByText("Documento Dois")).toBeTruthy();

    await user.type(
      screen.getByPlaceholderText(/buscar documento/i),
      "Documento",
    );

    // "Documento" casa os três; Dois é mantido (não reseta para o 1º).
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.getByText("Documento Dois")).toBeTruthy();
  });

  it("cai para o primeiro resultado quando o documento selecionado sai do filtro", async () => {
    const user = userEvent.setup();
    renderView(THREE_DOCS);

    await user.click(screen.getByRole("button", { name: /próximo documento/i })); // → Documento Dois
    expect(screen.getByText("Documento Dois")).toBeTruthy();

    await user.type(screen.getByPlaceholderText(/buscar documento/i), "Tres");

    expect(screen.getByText("1/1")).toBeTruthy();
    expect(screen.getByText("Documento Tres")).toBeTruthy();
  });

  it("aplica o filtro default 'pending' quando há itens pendentes", () => {
    renderView([
      makeItem({
        documentId: "dp",
        documentTitle: "Doc Pendente",
        isCorrect: false,
        acknowledgmentStatus: "pending",
        verdict: "nao",
      }),
      makeItem({
        documentId: "dok",
        documentTitle: "Doc Correto",
        isCorrect: true,
      }),
    ]);

    // Só o doc com item pendente aparece; o correto fica fora.
    expect(screen.getByText("1/1")).toBeTruthy();
    expect(screen.getByText("Doc Pendente")).toBeTruthy();
    expect(screen.queryByText("Doc Correto")).toBeNull();
  });
});
