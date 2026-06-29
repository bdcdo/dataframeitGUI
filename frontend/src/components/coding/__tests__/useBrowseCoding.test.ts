// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { saveResponse } from "@/actions/responses";
import { useBrowseDocuments } from "@/hooks/useBrowseDocuments";
import { useDocumentForCoding } from "@/hooks/useDocumentForCoding";
import type { BrowseDocument } from "@/actions/documents";
import { useBrowseCoding } from "../useBrowseCoding";

// Mocka os hooks de dados para asserir os contratos da #257 em isolamento:
// markResponded(intent), invalidate(id) e a exposição de error/retry.
vi.mock("@/hooks/useBrowseDocuments", () => ({ useBrowseDocuments: vi.fn() }));
vi.mock("@/hooks/useDocumentForCoding", () => ({ useDocumentForCoding: vi.fn() }));
vi.mock("@/actions/responses", () => ({ saveResponse: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockUseBrowseDocuments = vi.mocked(useBrowseDocuments);
const mockUseDocumentForCoding = vi.mocked(useDocumentForCoding);
const mockSave = vi.mocked(saveResponse);

const markResponded = vi.fn();
const retry = vi.fn();
const invalidate = vi.fn();

function browseDoc(id: string, overrides?: Partial<BrowseDocument>): BrowseDocument {
  return {
    id,
    external_id: `ext-${id}`,
    title: `Doc ${id}`,
    created_at: "2026-01-01",
    responseCount: 2,
    userAlreadyResponded: false,
    ...overrides,
  };
}

function setBrowseDocs(
  over?: Partial<ReturnType<typeof useBrowseDocuments>>,
) {
  mockUseBrowseDocuments.mockReturnValue({
    documents: [browseDoc("b1"), browseDoc("b2")],
    loading: false,
    error: false,
    retry,
    markResponded,
    ...over,
  });
}

function setDoc(over?: Partial<ReturnType<typeof useDocumentForCoding>>) {
  mockUseDocumentForCoding.mockReturnValue({
    doc: {
      document: { id: "b1", external_id: "ext-b1", title: "Doc b1", text: "txt" },
      initialAnswers: {},
      initialNotes: "",
    } as ReturnType<typeof useDocumentForCoding>["doc"],
    loading: false,
    invalidate,
    ...over,
  });
}

function setup(docParam: string | null, dirty = new Set<string>()) {
  const params = {
    projectId: "p1",
    documents: [], // nenhum atribuído → docParam vira browseDocId
    mode: "browse" as const,
    docParam,
    setSubmitting: vi.fn(),
    markDirty: vi.fn((id: string) => dirty.add(id)),
    markClean: vi.fn((id: string) => dirty.delete(id)),
    isDirty: (id: string | null | undefined) => !!id && dirty.has(id),
    updateDocParam: vi.fn(),
  };
  return { view: renderHook(() => useBrowseCoding(params)), params, dirty };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  setBrowseDocs();
  setDoc();
  mockSave.mockResolvedValue({ success: true });
});

describe("useBrowseCoding", () => {
  it("deriva browseDocId do ?doc= e expõe info da lista", () => {
    const { view } = setup("b1");
    expect(view.result.current.browseDocId).toBe("b1");
    expect(view.result.current.browseDocInfo?.responseCount).toBe(2);
  });

  it("submit salva, marca respondido (intent submit), invalida e limpa a seleção", async () => {
    const { view, params } = setup("b1");

    await act(async () => {
      await view.result.current.handleBrowseSubmit({ answers: { q: "sim" }, notes: "n" });
    });

    expect(mockSave).toHaveBeenCalledWith("p1", "b1", { q: "sim" }, { notes: "n" });
    expect(params.markClean).toHaveBeenCalledWith("b1");
    expect(markResponded).toHaveBeenCalledWith("b1");
    expect(invalidate).toHaveBeenCalledWith("b1");
    expect(params.updateDocParam).toHaveBeenCalledWith(null);
  });

  it("nº3: duplo-clique em Enviar não duplica saveResponse (guarda de reentrância)", async () => {
    let resolveSave: (v: { success: boolean }) => void = () => {};
    mockSave.mockReturnValue(
      new Promise<{ success: boolean }>((r) => {
        resolveSave = r;
      }),
    );
    const { view } = setup("b1");

    // Dois envios antes do primeiro save em voo resolver: o segundo é barrado
    // pela guarda de reentrância, então saveResponse roda só uma vez.
    const p1 = view.result.current.handleBrowseSubmit({
      answers: { q: "sim" },
      notes: "",
    });
    const p2 = view.result.current.handleBrowseSubmit({
      answers: { q: "sim" },
      notes: "",
    });
    expect(mockSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave({ success: true });
      await Promise.all([p1, p2]);
    });
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("getPayload reflete o rascunho reportado", () => {
    const { view } = setup("b1");
    act(() => view.result.current.handleDraftChange({ answers: { q: "x" }, notes: "nota" }));
    expect(view.result.current.getPayload()).toEqual({
      projectId: "p1",
      documentId: "b1",
      answers: { q: "x" },
      notes: "nota",
    });
  });

  it("back autosalva o doc sujo, marca respondido, invalida e limpa", async () => {
    const dirty = new Set<string>();
    const { view, params } = setup("b1", dirty);
    act(() => view.result.current.handleDraftChange({ answers: { q: "x" }, notes: "nota" })); // marca sujo
    await act(async () => {
      await view.result.current.handleBrowseBack();
    });
    expect(mockSave).toHaveBeenCalledWith(
      "p1",
      "b1",
      { q: "x" },
      { notes: "nota", isAutoSave: true },
    );
    expect(markResponded).toHaveBeenCalledWith("b1");
    expect(invalidate).toHaveBeenCalledWith("b1");
    expect(params.updateDocParam).toHaveBeenCalledWith(null);
  });

  it("back que falha mantém o doc aberto e não descarta o rascunho (#257)", async () => {
    mockSave.mockResolvedValue({ success: false, error: "falha" });
    const dirty = new Set<string>();
    const { view, params } = setup("b1", dirty);
    act(() => view.result.current.handleDraftChange({ answers: { q: "x" }, notes: "nota" }));
    await act(async () => {
      await view.result.current.handleBrowseBack();
    });
    // não navega (mantém o doc aberto) e o rascunho continua disponível
    expect(params.updateDocParam).not.toHaveBeenCalled();
    expect(view.result.current.getPayload()).toEqual({
      projectId: "p1",
      documentId: "b1",
      answers: { q: "x" },
      notes: "nota",
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("expõe error/retry da lista", () => {
    setBrowseDocs({ documents: null, error: true });
    const { view } = setup(null);
    expect(view.result.current.browseError).toBe(true);
    act(() => view.result.current.retryBrowse());
    expect(retry).toHaveBeenCalled();
  });

  it("retryBrowseDoc invalida o doc selecionado", () => {
    const { view } = setup("b1");
    act(() => view.result.current.retryBrowseDoc());
    expect(invalidate).toHaveBeenCalledWith("b1");
  });
});
