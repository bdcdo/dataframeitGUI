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

describe("useDocumentUpload — propaga a linha original (metadata) ao upload", () => {
  it("colunas extras não mapeadas chegam a uploadDocuments em metadata", async () => {
    checkDuplicates.mockResolvedValue({ duplicates: [], duplicatesWithResponses: 0 });
    uploadDocuments.mockResolvedValue({ count: 1 });

    const { result } = renderHook(() => useDocumentUpload("p1"));
    // CSV com coluna 'tribunal' não mapeada + 'classe' vazia.
    feedCsv(
      [{ text_col: "conteúdo", tribunal: "TJSP", classe: "" }],
      ["text_col", "tribunal", "classe"]
    );
    await act(async () => {
      await result.current.handleFile(
        new File(["x"], "t.csv", { type: "text/csv" })
      );
    });
    act(() =>
      result.current.setMapping({ text: "text_col", title: "", external_id: "" })
    );

    await act(async () => {
      await result.current.handleCheckAndUpload();
    });

    expect(uploadDocuments).toHaveBeenCalled();
    const docs = uploadDocuments.mock.calls[0][1] as {
      metadata?: { original_row: Record<string, string>; original_columns: string[] };
    }[];
    expect(docs[0].metadata).toEqual({
      original_row: { text_col: "conteúdo", tribunal: "TJSP", classe: "" },
      original_columns: ["text_col", "tribunal", "classe"],
    });
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

  it("agrega count quando 2+ chunks entram (todos com sucesso)", async () => {
    // 501 docs → 2 chunks (teto de 500); ambos entram. totalInserted = 500 + 1.
    const rows = Array.from({ length: 501 }, (_, i) => ({ text_col: `linha ${i}` }));
    checkDuplicates.mockResolvedValue({ duplicates: [], duplicatesWithResponses: 0 });
    uploadDocuments
      .mockResolvedValueOnce({ count: 500 })
      .mockResolvedValueOnce({ count: 1 });

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
    // A soma entre chunks (não só o último) chega ao toast de sucesso.
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("501"));
    expect(result.current.phase.kind).toBe("idle");
  });
});

describe("useDocumentUpload — falha parcial multi-chunk revalida cache", () => {
  it("revalida e reporta o parcial quando um chunk falha após outros entrarem", async () => {
    // 501 docs → 2 chunks; o 2º falha. O 1º (500) já entrou: revalida para que
    // apareçam, e reporta o parcial (só o último chunk revalidaria no servidor).
    const rows = Array.from({ length: 501 }, (_, i) => ({ text_col: `linha ${i}` }));
    checkDuplicates.mockResolvedValue({ duplicates: [], duplicatesWithResponses: 0 });
    uploadDocuments
      .mockResolvedValueOnce({ count: 500 })
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

  it("revalidação que REJEITA no catch não trava a UI em 'uploading'", async () => {
    // Parcial → catch → revalida. Se a Server Action rejeitar (falha de
    // transporte), o setPhase(returnTo) ainda precisa rodar: UI volta a 'mapping'.
    const rows = Array.from({ length: 501 }, (_, i) => ({ text_col: `linha ${i}` }));
    checkDuplicates.mockResolvedValue({ duplicates: [], duplicatesWithResponses: 0 });
    uploadDocuments
      .mockResolvedValueOnce({ count: 500 })
      .mockResolvedValueOnce({ error: "boom" });
    revalidateProjectDocuments.mockRejectedValueOnce(new Error("revalidate down"));

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

    expect(revalidateProjectDocuments).toHaveBeenCalledWith("p1");
    // Crítico: não preso em 'uploading'/loading apesar da revalidação ter falhado.
    expect(result.current.phase.kind).toBe("mapping");
    expect(result.current.loading).toBe(false);
  });
});

describe("useDocumentUpload — replace destrutivo falhando", () => {
  it("replace_and_add+deleteResponses falhando revalida e avisa da remoção", async () => {
    // Deletes/resets do replace podem já ter ocorrido mesmo sem inserção: mesmo
    // com totalInserted===0, revalida e avisa (não "nada aconteceu").
    checkDuplicates.mockResolvedValue({
      duplicates: [{ csvIndex: 0, existingDocId: "d1", matchType: "external_id" }],
      duplicatesWithResponses: 1,
    });
    uploadDocuments.mockResolvedValue({ error: "boom" });

    const { result } = renderHook(() => useDocumentUpload("p1"));
    await primeMapping(result);
    await act(async () => {
      await result.current.handleCheckAndUpload();
    });
    expect(result.current.phase.kind).toBe("analysis");

    act(() => result.current.handleReplaceAndImport(true));

    await waitFor(() =>
      expect(revalidateProjectDocuments).toHaveBeenCalledWith("p1")
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining("removidas"))
    );
    await waitFor(() => expect(result.current.phase.kind).toBe("analysis"));
  });

  it("multi-chunk parcial (totalInserted > 0) ainda avisa da remoção destrutiva", async () => {
    // 501 docs com duplicatas → analysis → replace destrutivo. 2 chunks: o 1º
    // entra (count 500), o 2º falha após já ter apagado responses/reviews. Como
    // totalInserted > 0, cai no ramo de parcial — que NÃO pode engolir o aviso de
    // remoção (os dois ramos não são exclusivos num replace multi-chunk).
    const rows = Array.from({ length: 501 }, (_, i) => ({ text_col: `linha ${i}` }));
    checkDuplicates.mockResolvedValue({
      duplicates: [{ csvIndex: 0, existingDocId: "d1", matchType: "external_id" }],
      duplicatesWithResponses: 1,
    });
    uploadDocuments
      .mockResolvedValueOnce({ count: 500 })
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
    expect(result.current.phase.kind).toBe("analysis");

    act(() => result.current.handleReplaceAndImport(true));

    await waitFor(() => expect(uploadDocuments).toHaveBeenCalledTimes(2));
    // Reporta o parcial (500) E avisa da remoção — sem o fix, "removidas" sumiria.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining("500"))
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining("removidas"))
    );
  });
});

describe("useDocumentUpload — erros de parsing do CSV", () => {
  it("erro fatal do Papa.parse aborta em 'idle' com toast contendo a causa", async () => {
    parse.mockImplementation(
      (_file: unknown, opts: { error: (e: Error) => void }) => {
        opts.error(new Error("arquivo corrompido"));
      }
    );

    const { result } = renderHook(() => useDocumentUpload("p1"));
    await act(async () => {
      await result.current.handleFile(new File(["x"], "t.csv"));
    });

    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("arquivo corrompido")
    );
    expect(result.current.phase.kind).toBe("idle");
  });

  it("avisos de parsing (results.errors) seguem para 'mapping' reportando a contagem", async () => {
    feedCsv([{ text_col: "ok" }], ["text_col"], [{ type: "Quotes" }]);

    const { result } = renderHook(() => useDocumentUpload("p1"));
    await act(async () => {
      await result.current.handleFile(new File(["x"], "t.csv"));
    });

    expect(toastWarning).toHaveBeenCalledWith(expect.stringContaining("1"));
    expect(result.current.phase.kind).toBe("mapping");
  });
});
