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
    // Sem o ramo de erro o loading derivado ficaria preso para sempre (skeleton infinito).
    mockGet.mockRejectedValue(new Error("falha de transporte"));
    const { result } = renderHook(() => useDocumentText("p1", "d1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.text).toBe("(Erro ao carregar o documento)");
  });

  it("re-tenta ao renavegar: erro não fica memoizado no cache", async () => {
    // A 1ª busca de d1 falha (blip transitório); ao voltar para d1, o hook deve
    // re-buscar — o erro vai para `failed` (evictável), não para o `cache`.
    let d1Calls = 0;
    mockGet.mockImplementation(async (_p, id) => {
      if (id === "d1") {
        d1Calls += 1;
        if (d1Calls === 1) throw new Error("blip");
        return { text: "d1-recuperado", title: "d1" };
      }
      return { text: `txt-${id}`, title: id };
    });

    const { result, rerender } = renderHook(
      ({ id }) => useDocumentText("p1", id),
      { initialProps: { id: "d1" } },
    );

    await waitFor(() =>
      expect(result.current.text).toBe("(Erro ao carregar o documento)"),
    );

    // Renavega para outro doc e volta — a volta dispara nova tentativa de d1.
    rerender({ id: "d2" });
    await waitFor(() => expect(result.current.text).toBe("txt-d2"));

    rerender({ id: "d1" });
    await waitFor(() => expect(result.current.text).toBe("d1-recuperado"));
    expect(d1Calls).toBe(2);
  });

  it("não busca quando documentId é null", () => {
    const { result } = renderHook(() => useDocumentText("p1", null));

    expect(result.current.loading).toBe(false);
    expect(result.current.text).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
