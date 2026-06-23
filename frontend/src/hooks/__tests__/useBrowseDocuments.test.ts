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

  it("markResponded com bump incrementa o contador uma vez e marca respondido", async () => {
    mockGet.mockResolvedValue([doc("d1", { responseCount: 2 }), doc("d2")]);
    const { result } = renderHook(() => useBrowseDocuments("p1", true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.markResponded("d1", true));
    let d1 = result.current.documents?.find((d) => d.id === "d1");
    expect(d1?.userAlreadyResponded).toBe(true);
    expect(d1?.responseCount).toBe(3);

    // Idempotente: segunda chamada não incrementa de novo (já respondido).
    act(() => result.current.markResponded("d1", true));
    d1 = result.current.documents?.find((d) => d.id === "d1");
    expect(d1?.responseCount).toBe(3);
  });

  it("markResponded sem bump marca respondido sem mexer no contador", async () => {
    mockGet.mockResolvedValue([doc("d1", { responseCount: 5 })]);
    const { result } = renderHook(() => useBrowseDocuments("p1", true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.markResponded("d1", false));
    const d1 = result.current.documents?.find((d) => d.id === "d1");
    expect(d1?.userAlreadyResponded).toBe(true);
    expect(d1?.responseCount).toBe(5);
  });

  it("não bumpa contador de doc já respondido", async () => {
    mockGet.mockResolvedValue([
      doc("d1", { responseCount: 4, userAlreadyResponded: true }),
    ]);
    const { result } = renderHook(() => useBrowseDocuments("p1", true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.markResponded("d1", true));
    const d1 = result.current.documents?.find((d) => d.id === "d1");
    expect(d1?.responseCount).toBe(4);
  });
});
