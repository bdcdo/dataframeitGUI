// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

// papaparse não tinha precedente de mock no projeto: handleFile faz
// `(await import("papaparse")).default`, então mockamos o default export.
const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
const { checkDuplicates, uploadDocuments } = vi.hoisted(() => ({
  checkDuplicates: vi.fn(),
  uploadDocuments: vi.fn(),
}));
const { toastSuccess, toastError, toastWarning } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("papaparse", () => ({ default: { parse } }));
vi.mock("@/actions/documents", () => ({ checkDuplicates, uploadDocuments }));
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

describe("useDocumentUpload — contagem do toast de sucesso", () => {
  it("importação completa anuncia o total, sem menção a ignorados", async () => {
    checkDuplicates.mockResolvedValue({ duplicates: [], duplicatesWithResponses: 0 });
    uploadDocuments.mockResolvedValue({ count: 1 });

    const { result } = renderHook(() => useDocumentUpload("p1"));
    await primeMapping(result);

    await act(async () => {
      await result.current.handleCheckAndUpload();
    });

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const msg = toastSuccess.mock.calls[0][0] as string;
    expect(msg).toContain("importados");
    expect(msg).not.toContain("ignorado");
    expect(result.current.phase.kind).toBe("idle");
  });

  it("quando o backend pula duplicatas (count < total), o toast reporta os ignorados", async () => {
    // 1 doc, marcado como duplicata → painel de análise → "importar só novos".
    checkDuplicates.mockResolvedValue({
      duplicates: [{ csvIndex: 0, existingDocId: "d1", matchType: "external_id" }],
      duplicatesWithResponses: 0,
    });
    // add_new_only pula a duplicata: nada inserido.
    uploadDocuments.mockResolvedValue({ count: 0 });

    const { result } = renderHook(() => useDocumentUpload("p1"));
    await primeMapping(result);

    await act(async () => {
      await result.current.handleCheckAndUpload();
    });
    expect(result.current.phase.kind).toBe("analysis");

    await act(async () => {
      result.current.handleImportNewOnly();
    });

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const msg = toastSuccess.mock.calls[0][0] as string;
    // 0 importados, 1 ignorado — não pode afirmar "1 documentos importados!".
    expect(msg).toContain("ignorado");
    expect(msg).toMatch(/0 documento/);
  });
});
