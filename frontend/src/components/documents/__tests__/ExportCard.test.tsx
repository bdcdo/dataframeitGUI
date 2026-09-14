// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportCard } from "@/components/documents/ExportCard";
import type { ExportDataset } from "@/lib/export/assemble";
import { toast } from "sonner";

const hoisted = vi.hoisted(() => ({
  getExportDataset: vi.fn(),
}));

vi.mock("@/actions/export", () => ({
  getExportDataset: (...a: unknown[]) => hoisted.getExportDataset(...(a as [])),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function makeDataset(overrides: Partial<ExportDataset> = {}): ExportDataset {
  const empty = { headers: [], rows: [] };
  return {
    projectName: "Proj",
    documents: { headers: ["document_id", "document_title"], rows: [["EXT-1", "T"]] },
    responses: empty,
    verdicts: empty,
    csv: {
      headers: ["document_id", "document_title", "source"],
      rows: [["EXT-1", "T", "documento"]],
    },
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  hoisted.getExportDataset.mockReset();
  vi.mocked(toast.info).mockClear();
});

describe("ExportCard", () => {
  it("no mount NÃO busca o dataset; mostra 'Gerar prévia' e 'Baixar CSV'", () => {
    render(<ExportCard projectId="p1" />);
    expect(hoisted.getExportDataset).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Gerar prévia" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Baixar CSV/ })).toBeTruthy();
    expect(screen.queryByText(/Prévia \(/)).toBeNull();
  });

  it("clicar 'Gerar prévia' busca o dataset e renderiza a tabela de prévia", async () => {
    hoisted.getExportDataset.mockResolvedValue(makeDataset());
    render(<ExportCard projectId="p1" />);

    await userEvent.click(screen.getByRole("button", { name: "Gerar prévia" }));

    await waitFor(() =>
      expect(hoisted.getExportDataset).toHaveBeenCalledWith("p1"),
    );
    expect(await screen.findByText(/Prévia \(1 linha\)/)).toBeTruthy();
    // Cabeçalhos da visão unificada aparecem na prévia.
    expect(screen.getByText("source")).toBeTruthy();
    expect(screen.getByText("document_id")).toBeTruthy();
  });

  it("erro da action é exibido, sem prévia", async () => {
    hoisted.getExportDataset.mockResolvedValue({ error: "Sem permissão" });
    render(<ExportCard projectId="p1" />);

    await userEvent.click(screen.getByRole("button", { name: "Gerar prévia" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Sem permissão",
    );
    expect(screen.queryByText(/Prévia \(/)).toBeNull();
  });

  it("não baixa a prévia antiga quando a atualização do download falha", async () => {
    const download = vi.fn(() => "blob:export");
    vi.stubGlobal("URL", { createObjectURL: download, revokeObjectURL: vi.fn() });
    hoisted.getExportDataset
      .mockResolvedValueOnce(makeDataset())
      .mockResolvedValueOnce({ error: "Não foi possível atualizar as decisões." });
    try {
      render(<ExportCard projectId="p1" />);
      await userEvent.click(screen.getByRole("button", { name: "Gerar prévia" }));
      await screen.findByText(/Prévia \(1 linha\)/);
      await userEvent.click(screen.getByRole("button", { name: /Baixar CSV/ }));
      expect(hoisted.getExportDataset).toHaveBeenCalledTimes(2);
      expect((await screen.findByRole("alert")).textContent).toContain("atualizar as decisões");
      expect(download).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("neutraliza fórmula no CSV sem alterar um número negativo", async () => {
    let downloaded: Blob | undefined;
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => { downloaded = blob; return "blob:export"; },
      revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    hoisted.getExportDataset.mockResolvedValue(makeDataset({ csv: { headers: ["formula", "numero"], rows: [["=1+1", "-12.5"]] } }));
    try {
      render(<ExportCard projectId="p1" />);
      await userEvent.click(screen.getByRole("button", { name: /Baixar CSV/ }));
      await waitFor(() => expect(downloaded).toBeTruthy());
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(downloaded!);
      });
      expect(text).toContain("\n'=1+1,-12.5");
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("dataset vazio mostra estado vazio e desabilita o download", async () => {
    hoisted.getExportDataset.mockResolvedValue(
      makeDataset({ csv: { headers: ["document_id"], rows: [] } }),
    );
    render(<ExportCard projectId="p1" />);

    await userEvent.click(screen.getByRole("button", { name: "Gerar prévia" }));

    expect(
      await screen.findByText("Nenhum documento para exportar."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Baixar CSV/ }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("baixar sem prévia em base vazia avisa e não gera arquivo", async () => {
    hoisted.getExportDataset.mockResolvedValue(
      makeDataset({ csv: { headers: ["document_id"], rows: [] } }),
    );
    render(<ExportCard projectId="p1" />);

    // Sem clicar em "Gerar prévia" antes: o primeiro clique carrega o dataset
    // (vazio) e deve curto-circuitar com um toast informativo, sem download.
    await userEvent.click(screen.getByRole("button", { name: /Baixar CSV/ }));

    await waitFor(() =>
      expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
        "Nenhum documento para exportar.",
      ),
    );
  });
});
