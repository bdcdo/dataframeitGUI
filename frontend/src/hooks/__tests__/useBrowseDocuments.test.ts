// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { useBrowseDocuments } from "../useBrowseDocuments";
import { getDocumentsForBrowse, type BrowseDocument } from "@/actions/documents";

vi.mock("@/actions/documents", () => ({
  getDocumentsForBrowse: vi.fn(),
}));

const mockGet = vi.mocked(getDocumentsForBrowse);

function doc(id: string, overrides?: Partial<BrowseDocument>): BrowseDocument {
  return {
    id,
    external_id: `ext-${id}`,
    title: `Título ${id}`,
    created_at: "2026-01-01",
    responseCount: 0,
    userAlreadyResponded: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useBrowseDocuments", () => {
  it("carrega a lista e deriva loading", async () => {
    mockGet.mockResolvedValue([doc("d1"), doc("d2")]);
    const { result } = renderHook(() => useBrowseDocuments("p1", true));

    expect(result.current.loading).toBe(true);
    expect(result.current.documents).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.documents?.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(mockGet).toHaveBeenCalledWith("p1");
  });

  it("não busca quando desabilitado", () => {
    const { result } = renderHook(() => useBrowseDocuments("p1", false));
    expect(result.current.loading).toBe(false);
    expect(result.current.documents).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('markResponded("submit") incrementa o contador uma vez e marca respondido', async () => {
    mockGet.mockResolvedValue([doc("d1", { responseCount: 2 }), doc("d2")]);
    const { result } = renderHook(() => useBrowseDocuments("p1", true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.markResponded("d1", "submit"));
    let d1 = result.current.documents?.find((d) => d.id === "d1");
    expect(d1?.userAlreadyResponded).toBe(true);
    expect(d1?.responseCount).toBe(3);

    // Idempotente: segunda chamada não incrementa de novo (já respondido).
    act(() => result.current.markResponded("d1", "submit"));
    d1 = result.current.documents?.find((d) => d.id === "d1");
    expect(d1?.responseCount).toBe(3);
  });

  it('markResponded("autosave") marca respondido sem mexer no contador', async () => {
    mockGet.mockResolvedValue([doc("d1", { responseCount: 5 })]);
    const { result } = renderHook(() => useBrowseDocuments("p1", true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.markResponded("d1", "autosave"));
    const d1 = result.current.documents?.find((d) => d.id === "d1");
    expect(d1?.userAlreadyResponded).toBe(true);
    expect(d1?.responseCount).toBe(5);
  });

  it("em erro expõe error=true e NÃO cacheia lista vazia; retry refaz o fetch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGet.mockRejectedValueOnce(new Error("falha de rede"));
    const { result } = renderHook(() => useBrowseDocuments("p1", true));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
    // null (não carregado), não [] — não mascara erro como "projeto sem docs".
    expect(result.current.documents).toBeNull();

    mockGet.mockResolvedValueOnce([doc("d1")]);
    act(() => result.current.retry());
    await waitFor(() =>
      expect(result.current.documents?.map((d) => d.id)).toEqual(["d1"]),
    );
    expect(result.current.error).toBe(false);
  });

  it('markResponded("submit") não bumpa contador de doc já respondido', async () => {
    mockGet.mockResolvedValue([
      doc("d1", { responseCount: 4, userAlreadyResponded: true }),
    ]);
    const { result } = renderHook(() => useBrowseDocuments("p1", true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.markResponded("d1", "submit"));
    const d1 = result.current.documents?.find((d) => d.id === "d1");
    expect(d1?.responseCount).toBe(4);
  });

  it("markResponded para docId inexistente é no-op", async () => {
    mockGet.mockResolvedValue([doc("d1")]);
    const { result } = renderHook(() => useBrowseDocuments("p1", true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.markResponded("fantasma", "submit"));
    expect(result.current.documents?.map((d) => d.id)).toEqual(["d1"]);
    expect(
      result.current.documents?.find((d) => d.id === "fantasma"),
    ).toBeUndefined();
  });

  it("toggle enabled true→false→true: refetch só 1x e preserva overrides", async () => {
    mockGet.mockResolvedValue([doc("d1", { responseCount: 1 })]);
    const { result, rerender } = renderHook(
      ({ on }) => useBrowseDocuments("p1", on),
      { initialProps: { on: true } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.markResponded("d1", "submit"));
    expect(
      result.current.documents?.find((d) => d.id === "d1")?.responseCount,
    ).toBe(2);

    rerender({ on: false });
    expect(result.current.documents).toBeNull();

    rerender({ on: true });
    await waitFor(() => expect(result.current.documents?.length).toBe(1));
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(
      result.current.documents?.find((d) => d.id === "d1")?.responseCount,
    ).toBe(2);
  });
});
