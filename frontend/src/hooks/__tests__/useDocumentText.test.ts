// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { useDocumentText } from "../useDocumentText";
import { getDocumentText } from "@/actions/documents";

vi.mock("@/actions/documents", () => ({
  getDocumentText: vi.fn(),
}));

const mockGet = vi.mocked(getDocumentText);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useDocumentText", () => {
  it("busca o texto e expõe loading durante o fetch", async () => {
    mockGet.mockResolvedValue({ text: "conteúdo", title: "t" });
    const { result } = renderHook(() => useDocumentText("p1", "d1"));

    expect(result.current.loading).toBe(true);
    expect(result.current.text).toBeUndefined();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.text).toBe("conteúdo");
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith("p1", "d1");
  });

  it("usa cache: não re-busca um doc já carregado", async () => {
    mockGet.mockImplementation(async (_p, id) => ({ text: `txt-${id}`, title: id }));
    const { result, rerender } = renderHook(
      ({ id }) => useDocumentText("p1", id),
      { initialProps: { id: "d1" } },
    );

    await waitFor(() => expect(result.current.text).toBe("txt-d1"));
    rerender({ id: "d2" });
    await waitFor(() => expect(result.current.text).toBe("txt-d2"));

    rerender({ id: "d1" });
    // Cache hit: texto imediato, sem loading e sem novo fetch.
    expect(result.current.text).toBe("txt-d1");
    expect(result.current.loading).toBe(false);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("usa fallback quando o doc não é encontrado", async () => {
    mockGet.mockResolvedValue(null);
    const { result } = renderHook(() => useDocumentText("p1", "d1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.text).toBe("(Documento não encontrado)");
  });

  it("destrava loading com sentinela de erro quando a action rejeita", async () => {
    // Sem .catch o loading derivado ficaria preso para sempre (skeleton infinito).
    mockGet.mockRejectedValue(new Error("falha de transporte"));
    const { result } = renderHook(() => useDocumentText("p1", "d1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.text).toBe("(Erro ao carregar o documento)");
  });

  it("não busca quando documentId é null", () => {
    const { result } = renderHook(() => useDocumentText("p1", null));

    expect(result.current.loading).toBe(false);
    expect(result.current.text).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
