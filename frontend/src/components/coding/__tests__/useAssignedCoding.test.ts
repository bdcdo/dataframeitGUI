// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { saveResponse } from "@/actions/responses";
import { useAssignedCoding } from "../useAssignedCoding";
import type { Document, Assignment } from "@/lib/types";

vi.mock("@/actions/responses", () => ({ saveResponse: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// sortByRecent é testado em outro lugar; aqui usamos a ordem como vem.
vi.mock("@/lib/coding-sort", () => ({
  sortByRecent: (docs: unknown[]) => docs,
}));

const mockSave = vi.mocked(saveResponse);

type AssignedDoc = Document & { assignment?: Pick<Assignment, "id" | "status"> };

function doc(id: string): AssignedDoc {
  return {
    id,
    external_id: `ext-${id}`,
    title: `Doc ${id}`,
    text: `texto ${id}`,
  } as AssignedDoc;
}

const DOCS = [doc("d1"), doc("d2"), doc("d3")];

function setup(overrides?: {
  existingAnswers?: Record<string, Record<string, unknown>>;
  existingJustifications?: Record<string, Record<string, unknown>>;
  dirty?: Set<string>;
}) {
  const dirty = overrides?.dirty ?? new Set<string>();
  const params = {
    projectId: "p1",
    documents: DOCS,
    sortedDocuments: DOCS,
    codedAtByDoc: {},
    existingAnswers: overrides?.existingAnswers ?? {},
    existingJustifications: overrides?.existingJustifications ?? {},
    initialDocIndex: 0,
    setSubmitting: vi.fn(),
    markDirty: vi.fn((id: string) => dirty.add(id)),
    markClean: vi.fn((id: string) => dirty.delete(id)),
    isDirty: (id: string | null | undefined) => !!id && dirty.has(id),
    updateDocParam: vi.fn(),
    setParams: vi.fn(),
  };
  const view = renderHook(() => useAssignedCoding(params));
  return { view, params, dirty };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  mockSave.mockResolvedValue({ success: true });
});

describe("useAssignedCoding", () => {
  it("semeia respostas e notas das props (sem derived-useState)", () => {
    const { view } = setup({
      existingAnswers: { d1: { q: "a" } },
      existingJustifications: { d1: { _notes: "nota d1" } },
    });
    expect(view.result.current.currentDoc?.id).toBe("d1");
    expect(view.result.current.docAnswers).toEqual({ q: "a" });
    expect(view.result.current.docNotes).toBe("nota d1");
  });

  it("handleAnswer atualiza a resposta e marca sujo", () => {
    const { view, params } = setup();
    act(() => view.result.current.handleAnswer("q1", "sim"));
    expect(view.result.current.docAnswers).toEqual({ q1: "sim" });
    expect(params.markDirty).toHaveBeenCalledWith("d1");
  });

  it("handleSubmit avança o índice ao salvar com sucesso", async () => {
    const { view, params } = setup();
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(mockSave).toHaveBeenCalledWith("p1", "d1", { q1: "sim" }, {
      notes: "",
    });
    expect(params.markClean).toHaveBeenCalledWith("d1");
    expect(view.result.current.currentDoc?.id).toBe("d2");
    expect(params.updateDocParam).toHaveBeenCalledWith("d2");
  });

  it("handleSubmit marca allDone no último documento", async () => {
    const { view } = setup();
    act(() => view.result.current.handleDocNavigate(2)); // vai para d3 (último)
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(view.result.current.allDone).toBe(true);
  });

  it("handleDocNavigate autosalva o doc sujo antes de trocar (#28)", async () => {
    const { view, params } = setup();
    act(() => view.result.current.handleAnswer("q1", "sim")); // d1 fica sujo
    await act(async () => {
      view.result.current.handleDocNavigate(1);
    });
    // autosave do d1 com isAutoSave antes de navegar
    expect(mockSave).toHaveBeenCalledWith(
      "p1",
      "d1",
      { q1: "sim" },
      { notes: "", isAutoSave: true },
    );
    await waitFor(() => expect(params.markClean).toHaveBeenCalledWith("d1"));
    expect(view.result.current.currentDoc?.id).toBe("d2");
    expect(params.updateDocParam).toHaveBeenCalledWith("d2");
  });

  it("handleDocNavigate NÃO autosalva quando o doc não está sujo", () => {
    const { view } = setup();
    act(() => view.result.current.handleDocNavigate(1));
    expect(mockSave).not.toHaveBeenCalled();
    expect(view.result.current.currentDoc?.id).toBe("d2");
  });

  // Regressão da mudança de comportamento intencional: sair da tela "Parabéns!"
  // ao navegar ou trocar a ordenação (o `case "index"` do reducer zera allDone).
  it("handleDocNavigate zera allDone (sai da tela Parabéns ao navegar)", async () => {
    const { view } = setup();
    act(() => view.result.current.handleDocNavigate(2)); // vai para d3 (último)
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(view.result.current.allDone).toBe(true);

    act(() => view.result.current.handleDocNavigate(0)); // ◀ reabre o doc
    expect(view.result.current.allDone).toBe(false);
    expect(view.result.current.currentDoc?.id).toBe("d1");
  });

  it("handleSortChange zera allDone (sai da tela Parabéns ao reordenar)", async () => {
    const { view } = setup();
    act(() => view.result.current.handleDocNavigate(2)); // vai para d3 (último)
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(view.result.current.allDone).toBe(true);

    act(() => view.result.current.handleSortChange("recent"));
    expect(view.result.current.allDone).toBe(false);
  });

  it("getPayload reflete o doc e respostas atuais", () => {
    const { view } = setup({ existingAnswers: { d1: { q: "a" } } });
    expect(view.result.current.getPayload()).toEqual({
      projectId: "p1",
      documentId: "d1",
      answers: { q: "a" },
      notes: "",
    });
  });
});
