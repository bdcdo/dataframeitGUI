// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportCard } from "@/components/documents/ExportCard";
import type { ExportDataset } from "@/lib/export/assemble";

const hoisted = vi.hoisted(() => ({
  getExportDataset: vi.fn(),
}));

vi.mock("@/actions/export", () => ({
  getExportDataset: (...a: unknown[]) => hoisted.getExportDataset(...(a as [])),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
});
