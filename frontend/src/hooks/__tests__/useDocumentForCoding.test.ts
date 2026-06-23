// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { useDocumentForCoding } from "../useDocumentForCoding";
import { getDocumentForCoding } from "@/actions/documents";

vi.mock("@/actions/documents", () => ({
  getDocumentForCoding: vi.fn(),
}));

const mockGet = vi.mocked(getDocumentForCoding);

function makeResult(id: string, answers: Record<string, unknown> | null, notes?: string) {
  return {
    document: { id, external_id: `ext-${id}`, title: `Título ${id}`, text: `texto-${id}` },
    existingAnswers: answers,
    existingJustifications: notes !== undefined ? { _notes: notes } : null,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useDocumentForCoding", () => {
  it("carrega o doc e deriva loading durante o fetch", async () => {
    mockGet.mockResolvedValue(makeResult("d1", { q1: "sim" }, "nota inicial"));
    const { result } = renderHook(() => useDocumentForCoding("p1", "d1"));

    expect(result.current.loading).toBe(true);
    expect(result.current.doc).toBeUndefined();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.doc?.document.text).toBe("texto-d1");
    expect(result.current.doc?.initialAnswers).toEqual({ q1: "sim" });
    expect(result.current.doc?.initialNotes).toBe("nota inicial");
    expect(mockGet).toHaveBeenCalledWith("p1", "d1");
  });

  it("seed de respostas/notas vazias quando não há resposta prévia", async () => {
    mockGet.mockResolvedValue(makeResult("d1", null));
    const { result } = renderHook(() => useDocumentForCoding("p1", "d1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.doc?.initialAnswers).toEqual({});
    expect(result.current.doc?.initialNotes).toBe("");
  });

  it("usa cache: não re-busca um doc já carregado", async () => {
    mockGet.mockImplementation(async (_p, id) => makeResult(id, { q: id }));
    const { result, rerender } = renderHook(
      ({ id }) => useDocumentForCoding("p1", id),
      { initialProps: { id: "d1" } },
    );

    await waitFor(() => expect(result.current.doc?.document.text).toBe("texto-d1"));
    rerender({ id: "d2" });
    await waitFor(() => expect(result.current.doc?.document.text).toBe("texto-d2"));

    rerender({ id: "d1" });
    expect(result.current.doc?.document.text).toBe("texto-d1");
    expect(result.current.loading).toBe(false);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("cacheia null em erro (sem spinner infinito)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGet.mockRejectedValue(new Error("not found"));
    const { result } = renderHook(() => useDocumentForCoding("p1", "d1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.doc).toBeNull();
  });

  it("não busca quando documentId é null", () => {
    const { result } = renderHook(() => useDocumentForCoding("p1", null));

    expect(result.current.loading).toBe(false);
    expect(result.current.doc).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
