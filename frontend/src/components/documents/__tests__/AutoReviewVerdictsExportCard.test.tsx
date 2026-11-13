// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { stubRadixJsdomApis } from "@/test-utils/radix-jsdom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoReviewVerdictsExportCard } from "@/components/documents/AutoReviewVerdictsExportCard";
import type { AutoReviewVerdictData, AutoReviewVerdictRow } from "@/lib/export/auto-review-verdicts";
import type { PydanticField } from "@/lib/types";

const hoisted = vi.hoisted(() => ({
  getAutoReviewVerdicts: vi.fn(),
  downloadBlob: vi.fn(),
}));

vi.mock("@/actions/auto-review-export", () => ({
  getAutoReviewVerdicts: (...a: unknown[]) => hoisted.getAutoReviewVerdicts(...(a as [])),
}));
vi.mock("@/lib/download-blob", () => ({
  downloadBlob: (...a: unknown[]) => hoisted.downloadBlob(...(a as [])),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function review(over: Partial<AutoReviewVerdictRow>): AutoReviewVerdictRow {
  return {
    id: "r",
    document_id: "d1",
    field_name: "q",
    self_verdict: "ambiguo",
    self_justification: null,
    self_reviewer_id: "u1",
    human_answer_snapshot: "Sim",
    llm_answer_snapshot: "Não",
    llm_justification_snapshot: null,
    final_verdict: null,
    arbitrator_comment: null,
    field_hash: "h",
    cycle_no: 1,
    superseded_at: null,
    superseded_reason: null,
    ...over,
  };
}

function makeData(over: Partial<AutoReviewVerdictData> = {}): AutoReviewVerdictData {
  return {
    projectName: "Proj",
    fields: [{ name: "q", type: "text", description: "Q?", hash: "h" }] as unknown as PydanticField[],
    documents: [{ id: "d1", external_id: "N-1", title: "Doc" }],
    reviews: [
      review({ id: "1" }),
      review({ id: "2", self_verdict: "contesta_llm", self_reviewer_id: "u2" }),
      review({ id: "3", self_verdict: "equivalente" }),
    ],
    reviewers: [
      { id: "u1", name: "Ana" },
      { id: "u2", name: "Bia" },
    ],
    ...over,
  };
}

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => {
  stubRadixJsdomApis();
  return warmUpJsdom({ select: true });
}, 30_000);

afterEach(cleanup);
beforeEach(() => {
  hoisted.getAutoReviewVerdicts.mockReset();
  hoisted.downloadBlob.mockReset();
});

describe("AutoReviewVerdictsExportCard", () => {
  it("no mount não busca; carregar mostra a contagem com os três vereditos padrão", async () => {
    hoisted.getAutoReviewVerdicts.mockResolvedValue(makeData());
    render(<AutoReviewVerdictsExportCard projectId="p1" />);
    expect(hoisted.getAutoReviewVerdicts).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Equivalente" }).getAttribute("aria-checked")).toBe("false");

    await userEvent.click(screen.getByRole("button", { name: "Carregar vereditos" }));

    expect(hoisted.getAutoReviewVerdicts).toHaveBeenCalledWith("p1", { includeArchived: false });
    expect(await screen.findByText("2 linhas")).toBeTruthy();
  });

  it("marcar um veredito refiltra sem nova ida ao banco", async () => {
    hoisted.getAutoReviewVerdicts.mockResolvedValue(makeData());
    render(<AutoReviewVerdictsExportCard projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: "Carregar vereditos" }));
    await screen.findByText("2 linhas");

    await userEvent.click(screen.getByRole("checkbox", { name: "Equivalente" }));
    expect(screen.getByText("3 linhas")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Ambíguo" }));
    expect(screen.getByText("2 linhas")).toBeTruthy();
    expect(hoisted.getAutoReviewVerdicts).toHaveBeenCalledTimes(1);
  });

  it("incluir arquivados descarta os dados e recarrega com a opção", async () => {
    hoisted.getAutoReviewVerdicts.mockResolvedValue(makeData());
    render(<AutoReviewVerdictsExportCard projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: "Carregar vereditos" }));
    await screen.findByText("2 linhas");

    await userEvent.click(screen.getByRole("checkbox", { name: "Incluir ciclos que não valem mais" }));
    expect(screen.queryByText("2 linhas")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Carregar vereditos" }));

    expect(hoisted.getAutoReviewVerdicts).toHaveBeenLastCalledWith("p1", { includeArchived: true });
  });

  it("recarregar busca de novo e volta a 'Todos' se o pesquisador escolhido sumiu", async () => {
    hoisted.getAutoReviewVerdicts.mockResolvedValueOnce(makeData());
    render(<AutoReviewVerdictsExportCard projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: "Carregar vereditos" }));
    await screen.findByText("2 linhas");

    await userEvent.click(screen.getByRole("combobox", { name: "Pesquisador" }));
    await userEvent.click(await screen.findByRole("option", { name: "Bia" }));
    expect(screen.getByText("1 linha")).toBeTruthy();

    hoisted.getAutoReviewVerdicts.mockResolvedValueOnce(
      makeData({ reviews: [review({ id: "9" })], reviewers: [{ id: "u1", name: "Ana" }] }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Recarregar" }));

    expect(await screen.findByText("1 linha")).toBeTruthy();
    expect(hoisted.getAutoReviewVerdicts).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("combobox", { name: "Pesquisador" }).textContent).toBe("Todos");
  });

  it("mostra o erro da action", async () => {
    hoisted.getAutoReviewVerdicts.mockResolvedValue({ error: "Apenas coordenadores" });
    render(<AutoReviewVerdictsExportCard projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: "Carregar vereditos" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Apenas coordenadores");
  });

  it("baixar gera o XLSX com o nome do projeto", async () => {
    hoisted.getAutoReviewVerdicts.mockResolvedValue(makeData());
    render(<AutoReviewVerdictsExportCard projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: "Carregar vereditos" }));
    await screen.findByText("2 linhas");

    await userEvent.click(screen.getByRole("button", { name: /Baixar XLSX/ }));

    await waitFor(() => expect(hoisted.downloadBlob).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const [blob, filename] = hoisted.downloadBlob.mock.calls[0] as [Blob, string];
    expect(filename).toMatch(/^Proj-vereditos-auto-revisao-.+\.xlsx$/);
    expect(blob.size).toBeGreaterThan(0);
  });

  it("sem célula nos filtros o botão de baixar fica desabilitado", async () => {
    hoisted.getAutoReviewVerdicts.mockResolvedValue(makeData({ reviews: [] }));
    render(<AutoReviewVerdictsExportCard projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: "Carregar vereditos" }));
    await screen.findByText("0 linhas");
    expect(screen.getByRole("button", { name: /Baixar XLSX/ }).hasAttribute("disabled")).toBe(true);
  });
});
