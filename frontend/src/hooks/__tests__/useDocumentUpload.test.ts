// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

// papaparse não tinha precedente de mock no projeto: handleFile faz
// `(await import("papaparse")).default`, então mockamos o default export.
const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
const { checkDuplicates, uploadDocuments, revalidateProjectDocuments } =
  vi.hoisted(() => ({
    checkDuplicates: vi.fn(),
    uploadDocuments: vi.fn(),
    revalidateProjectDocuments: vi.fn(async () => {}),
  }));
const { toastSuccess, toastError, toastWarning } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("papaparse", () => ({ default: { parse } }));
vi.mock("@/actions/documents", () => ({
  checkDuplicates,
  uploadDocuments,
  revalidateProjectDocuments,
}));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError, warning: toastWarning },
}));

import { useDocumentUpload } from "../useDocumentUpload";

// Faz o mock do Papa.parse chamar o callback `complete` como o handleFile espera.
function feedCsv(
  rows: Record<string, string>[],
  columns: string[],
  errors: unknown[] = []
) {
  parse.mockImplementation((_file: unknown, opts: { complete: (r: unknown) => void }) => {
    opts.complete({ data: rows, meta: { fields: columns }, errors });
  });
}

// Leva o hook de idle → mapping com um CSV de uma coluna de texto e seleciona
// essa coluna, deixando-o pronto para handleCheckAndUpload.
async function primeMapping(
  result: { current: ReturnType<typeof useDocumentUpload> }
) {
  feedCsv([{ text_col: "conteúdo" }], ["text_col"]);
  await act(async () => {
    await result.current.handleFile(new File(["x"], "t.csv", { type: "text/csv" }));
  });
  act(() =>
    result.current.setMapping({ text: "text_col", title: "", external_id: "" })
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useDocumentUpload — recuperação de falha (returnTo)", () => {
  it("falha de upload no caminho SEM duplicatas volta a 'mapping', não a painel em branco", async () => {
    checkDuplicates.mockResolvedValue({ duplicates: [], duplicatesWithResponses: 0 });
    uploadDocuments.mockResolvedValue({ error: "boom" });

    const { result } = renderHook(() => useDocumentUpload("p1"));
    await primeMapping(result);

    await act(async () => {
      await result.current.handleCheckAndUpload();
    });

    expect(uploadDocuments).toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(result.current.phase.kind).toBe("mapping");
    expect(result.current.loading).toBe(false);
    // csv preservado → retry possível
    expect(result.current.csv).not.toBeNull();
  });

  it("falha de upload no caminho COM duplicatas volta à fase 'analysis' (retryável)", async () => {
    checkDuplicates.mockResolvedValue({
      duplicates: [{ csvIndex: 0, existingDocId: "d1", matchType: "external_id" }],
      duplicatesWithResponses: 0,
    });
    uploadDocuments.mockResolvedValue({ error: "boom" });

    const { result } = renderHook(() => useDocumentUpload("p1"));
    await primeMapping(result);

    await act(async () => {
      await result.current.handleCheckAndUpload();
    });
    // checkDuplicates achou duplicata → painel de análise
    expect(result.current.phase.kind).toBe("analysis");

    act(() => result.current.handleImportAll());

    await waitFor(() => expect(uploadDocuments).toHaveBeenCalled());
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // restaura a análise (não some, não fica em 'uploading')
    await waitFor(() => expect(result.current.phase.kind).toBe("analysis"));
    if (result.current.phase.kind === "analysis") {
      expect(result.current.phase.analysis.docs).toHaveLength(1);
    }
  });
});

describe("useDocumentUpload — sucesso parcial em upload multi-chunk", () => {
  it("revalida e reporta o parcial quando um chunk falha após outros entrarem", async () => {
    // 501 docs → 2 chunks (teto de 500 por chunk); o 2º falha.
    const rows = Array.from({ length: 501 }, (_, i) => ({ text_col: `linha ${i}` }));
    checkDuplicates.mockResolvedValue({ duplicates: [], duplicatesWithResponses: 0 });
    uploadDocuments
      .mockResolvedValueOnce({ count: 500, skipped: 0 })
      .mockResolvedValueOnce({ error: "boom" });

    const { result } = renderHook(() => useDocumentUpload("p1"));
    feedCsv(rows, ["text_col"]);
    await act(async () => {
      await result.current.handleFile(new File(["x"], "t.csv"));
    });
    act(() =>
      result.current.setMapping({ text: "text_col", title: "", external_id: "" })
    );

    await act(async () => {
      await result.current.handleCheckAndUpload();
    });

    expect(uploadDocuments).toHaveBeenCalledTimes(2);
    expect(revalidateProjectDocuments).toHaveBeenCalledWith("p1");
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("500"));
    expect(result.current.phase.kind).toBe("mapping");
  });

  it("não revalida quando a falha ocorre no primeiro chunk (nada inserido)", async () => {
    checkDuplicates.mockResolvedValue({ duplicates: [], duplicatesWithResponses: 0 });
    uploadDocuments.mockResolvedValue({ error: "boom" });

    const { result } = renderHook(() => useDocumentUpload("p1"));
    await primeMapping(result);

    await act(async () => {
      await result.current.handleCheckAndUpload();
    });

    expect(revalidateProjectDocuments).not.toHaveBeenCalled();
    expect(result.current.phase.kind).toBe("mapping");
  });
});

describe("useDocumentUpload — erros de parsing do CSV", () => {
  it("erro fatal do Papa.parse aborta em 'idle' com toast", async () => {
    parse.mockImplementation(
      (_file: unknown, opts: { error: (e: Error) => void }) => {
        opts.error(new Error("arquivo corrompido"));
      }
    );

    const { result } = renderHook(() => useDocumentUpload("p1"));
    await act(async () => {
      await result.current.handleFile(new File(["x"], "t.csv"));
    });

    expect(toastError).toHaveBeenCalled();
    expect(result.current.phase.kind).toBe("idle");
  });

  it("avisos de parsing (results.errors) seguem para 'mapping'", async () => {
    feedCsv([{ text_col: "ok" }], ["text_col"], [{ type: "Quotes" }]);

    const { result } = renderHook(() => useDocumentUpload("p1"));
    await act(async () => {
      await result.current.handleFile(new File(["x"], "t.csv"));
    });

    expect(toastWarning).toHaveBeenCalled();
    expect(result.current.phase.kind).toBe("mapping");
  });
});
