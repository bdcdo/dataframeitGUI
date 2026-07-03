// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { useDocumentForCoding } from "../useDocumentForCoding";
import { getDocumentForCoding } from "@/actions/documents";

vi.mock("@/actions/documents", () => ({
  getDocumentForCoding: vi.fn(),
}));

const mockGet = vi.mocked(getDocumentForCoding);

function makeResult(id: string, answers: Record<string, unknown> | null, notes?: string) {
  return {
    document: { id, external_id: `ext-${id}`, title: `Título ${id}`, text: `texto-${id}`, exclusionPending: null },
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

  it("invalidate refaz o fetch e reflete as respostas salvas (anti-staleness pós-save)", async () => {
    // 1ª carga: respostas pré-envio; 2ª carga (pós-invalidate): respostas salvas.
    mockGet
      .mockResolvedValueOnce(makeResult("d1", { q1: "A" }, ""))
      .mockResolvedValueOnce(makeResult("d1", { q1: "A", q2: "B" }, ""));
    const { result } = renderHook(() => useDocumentForCoding("p1", "d1"));

    await waitFor(() =>
      expect(result.current.doc?.initialAnswers).toEqual({ q1: "A" }),
    );

    // Simula o que handleBrowseSubmit/handleBrowseBack devem fazer após salvar.
    act(() => result.current.invalidate("d1"));

    await waitFor(() =>
      expect(result.current.doc?.initialAnswers).toEqual({ q1: "A", q2: "B" }),
    );
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("cacheia null em erro (sem spinner infinito)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGet.mockRejectedValue(new Error("not found"));
    const { result } = renderHook(() => useDocumentForCoding("p1", "d1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.doc).toBeNull();
  });

  it("invalidate após erro permite retry (refetch bem-sucedido)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGet
      .mockRejectedValueOnce(new Error("falha de rede"))
      .mockResolvedValueOnce(makeResult("d1", { q1: "ok" }, ""));
    const { result } = renderHook(() => useDocumentForCoding("p1", "d1"));

    await waitFor(() => expect(result.current.doc).toBeNull());

    act(() => result.current.invalidate("d1"));
    await waitFor(() =>
      expect(result.current.doc?.initialAnswers).toEqual({ q1: "ok" }),
    );
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("não busca quando documentId é null", () => {
    const { result } = renderHook(() => useDocumentForCoding("p1", null));

    expect(result.current.loading).toBe(false);
    expect(result.current.doc).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("troca de documentId durante o loading descarta o resultado obsoleto", async () => {
    let resolveD1!: (v: ReturnType<typeof makeResult>) => void;
    mockGet
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveD1 = r;
          }),
      )
      .mockResolvedValueOnce(makeResult("d2", { q: "d2" }));

    const { result, rerender } = renderHook(
      ({ id }) => useDocumentForCoding("p1", id),
      { initialProps: { id: "d1" as string } },
    );

    // d1 ainda em voo; troca para d2 (cleanup marca o fetch de d1 como cancelado).
    rerender({ id: "d2" });
    await waitFor(() =>
      expect(result.current.doc?.document.text).toBe("texto-d2"),
    );

    // d1 resolve atrasado: por estar cancelado, NÃO sobrescreve o doc atual.
    resolveD1(makeResult("d1", { q: "d1" }));
    await Promise.resolve();
    expect(result.current.doc?.document.text).toBe("texto-d2");
  });
});
