// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { useCachedResource, deleteKey } from "../useCachedResource";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useCachedResource", () => {
  it("carrega e deriva loading", async () => {
    const fetcher = vi.fn(async (k: string) => `val-${k}`);
    const { result } = renderHook(() => useCachedResource("a", fetcher));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBe(false);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe("val-a");
    expect(fetcher).toHaveBeenCalledWith("a");
  });

  it("não busca quando key é null", () => {
    const fetcher = vi.fn(async (k: string) => k);
    const { result } = renderHook(() => useCachedResource(null, fetcher));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("não busca quando enabled=false", () => {
    const fetcher = vi.fn(async (k: string) => k);
    const { result } = renderHook(() =>
      useCachedResource("a", fetcher, { enabled: false }),
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("usa cache: não re-busca uma key já carregada", async () => {
    const fetcher = vi.fn(async (k: string) => `val-${k}`);
    const { result, rerender } = renderHook(
      ({ k }) => useCachedResource(k, fetcher),
      { initialProps: { k: "a" } },
    );
    await waitFor(() => expect(result.current.data).toBe("val-a"));
    rerender({ k: "b" });
    await waitFor(() => expect(result.current.data).toBe("val-b"));
    rerender({ k: "a" });
    expect(result.current.data).toBe("val-a");
    expect(result.current.loading).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejeição expõe error=true sem cachear; retry refaz o fetch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi
      .fn<(k: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("falha"))
      .mockResolvedValueOnce("val-a");
    const { result } = renderHook(() => useCachedResource("a", fetcher));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.data).toBe("val-a"));
    expect(result.current.error).toBe(false);
  });

  it("erro-como-valor: fetcher que faz catch nunca seta error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn(async (_k: string) => {
      try {
        throw new Error("boom");
      } catch {
        return null;
      }
    });
    const { result } = renderHook(() => useCachedResource("a", fetcher));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe(false);
  });

  it("invalidate refaz o fetch da key", async () => {
    const fetcher = vi
      .fn<(k: string) => Promise<string>>()
      .mockResolvedValueOnce("v1")
      .mockResolvedValueOnce("v2");
    const { result } = renderHook(() => useCachedResource("a", fetcher));
    await waitFor(() => expect(result.current.data).toBe("v1"));

    act(() => result.current.invalidate("a"));
    await waitFor(() => expect(result.current.data).toBe("v2"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("troca de key durante o loading descarta o resultado obsoleto", async () => {
    let resolveA!: (v: string) => void;
    const fetcher = vi
      .fn<(k: string) => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((r) => {
            resolveA = r;
          }),
      )
      .mockResolvedValueOnce("val-b");

    const { result, rerender } = renderHook(
      ({ k }) => useCachedResource(k, fetcher),
      { initialProps: { k: "a" } },
    );

    rerender({ k: "b" });
    await waitFor(() => expect(result.current.data).toBe("val-b"));

    // A resolve atrasado: por estar cancelado, NÃO sobrescreve o valor atual.
    resolveA("val-a");
    await Promise.resolve();
    expect(result.current.data).toBe("val-b");
  });

  it("maxEntries: ao exceder o teto, despeja a entrada mais antiga (FIFO)", async () => {
    const fetcher = vi.fn(async (k: string) => `val-${k}`);
    const { result, rerender } = renderHook(
      ({ k }) => useCachedResource(k, fetcher, { maxEntries: 2 }),
      { initialProps: { k: "a" } },
    );
    await waitFor(() => expect(result.current.data).toBe("val-a"));
    rerender({ k: "b" });
    await waitFor(() => expect(result.current.data).toBe("val-b"));
    rerender({ k: "c" }); // entra c → despeja a (mais antiga); cache = {b,c}
    await waitFor(() => expect(result.current.data).toBe("val-c"));
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Reabrir a: foi despejada → refetch (4ª chamada).
    rerender({ k: "a" });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe("val-a"));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("deleteKey", () => {
  it("remove a chave imutavelmente e é no-op se ausente", () => {
    const rec = { a: 1, b: 2 };
    const next = deleteKey(rec, "a");
    expect(next).toEqual({ b: 2 });
    expect(next).not.toBe(rec);
    expect(deleteKey(rec, "z")).toBe(rec);
  });
});
