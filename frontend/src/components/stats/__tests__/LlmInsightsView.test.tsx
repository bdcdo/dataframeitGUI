// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LlmInsightsView } from "@/components/stats/LlmInsightsView";
import type { LlmError } from "@/lib/llm-error-metrics";
import { resolutionFixture } from "@/lib/__tests__/error-resolution-fixture";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), resolve: vi.fn(), reopen: vi.fn(), refresh: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/actions/stats", () => ({ prepareErrorResolution: mocks.prepare, resolveError: mocks.resolve, reopenError: mocks.reopen }));
vi.mock("@/actions/field-reviews", () => ({ regenerateAutoReviewBacklog: vi.fn() }));
vi.mock("@/actions/equivalences", () => ({ markLlmEquivalent: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: mocks.success } }));

const row = resolutionFixture();
function errorCase(): LlmError {
  return { documentId: "doc1", documentTitle: "Documento", fieldName: "x", fieldDescription: "Pergunta",
    llmAnswer: "LLM", llmJustification: null, chosenVerdict: "Humano", reviewerComment: null,
    resolvedAt: null, reviewedAt: "2026-09-14T12:00:00Z", schemaVersion: null,
    llmResponseId: "rllm", chosenResponseId: "rh", source: "comparacao", sourceId: "review1" };
}
function show(error = errorCase(), canResolve = true) {
  render(<LlmInsightsView projectId="p1" errors={[error]} fields={[{ name: "x", description: "Pergunta" }]}
    reviewedEntries={[{ documentId: "doc1", documentTitle: "Documento", fieldName: "x", schemaVersion: null, reviewedAt: error.reviewedAt, isError: true }]}
    canResolve={canResolve} isCoordinator={false} summary={{ totalLlmDocs: 1 }} />);
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue({ context: row.context });
  mocks.resolve.mockResolvedValue({ success: true });
  mocks.reopen.mockResolvedValue({ success: true });
});

describe("decisão individual em Insights", () => {
  it("selecionar não grava; confirmar envia o contexto que foi mostrado", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "Erro humano" }));
    await screen.findByRole("dialog");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(screen.getByText("Valor que irá para o gabarito")).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Confirmar decisão" }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith("p1", "doc1", "x", {
      decision: "llm_correct", context: row.context, expected: null, note: "",
    }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a confirmação mostra o enunciado conferido no servidor", async () => {
    const current = structuredClone(row.context!);
    current.field_definition = { name: "x", type: "text", description: "Enunciado atualizado" };
    mocks.prepare.mockResolvedValue({ context: current });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Erro humano" }));
    await screen.findByRole("dialog");
    expect(screen.getByText("Documento · Enunciado atualizado")).toBeTruthy();
  });

  it("falha de escrita mantém a confirmação aberta e não anuncia sucesso", async () => {
    mocks.resolve.mockResolvedValue({ success: false, error: "A decisão mudou." });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Erro do LLM" }));
    await screen.findByRole("dialog");
    await userEvent.click(await screen.findByRole("button", { name: "Confirmar decisão" }));
    expect(mocks.error).toHaveBeenCalledWith("A decisão mudou.");
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("cancelar a discussão não grava nada", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "Em discussão" }));
    await screen.findByRole("dialog");
    expect(screen.getByText(/sem valor final aprovado/)).toBeTruthy();
    await screen.findByRole("button", { name: "Confirmar decisão" });
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("reabrir exige confirmação e conserva a identidade esperada", async () => {
    show({ ...errorCase(), resolution: { ...row, current_context: null } });
    await userEvent.click(screen.getByRole("button", { name: "Reabrir" }));
    expect(mocks.reopen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar reabertura" }));
    expect(mocks.reopen).toHaveBeenCalledWith("p1", "doc1", "x", { ...row, current_context: null });
  });

  it("sem resposta humana ativa o servidor explica o bloqueio e nada abre", async () => {
    mocks.prepare.mockResolvedValue({ error: "Nenhuma resposta humana ativa nesta rodada. Refaça a revisão antes de decidir." });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Erro humano" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("Nenhuma resposta humana ativa")));
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ preferredHumanResponseId: "rh" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Erro do LLM leva o veredito anterior, pré-preenchido, como valor (#733)", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "Erro do LLM" }));
    await screen.findByRole("dialog");
    expect(screen.getByText("Veredito anterior")).toBeTruthy();
    expect(screen.queryByText(/saiu do formulário/)).toBeNull();
    expect((screen.getByPlaceholderText("Digite sua resposta...") as HTMLTextAreaElement).value).toBe("Humano");
    await userEvent.click(await screen.findByRole("button", { name: "Confirmar decisão" }));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith("p1", "doc1", "x", {
      decision: "researchers_correct", context: row.context, expected: null, note: "", value: "Humano",
    }));
  });

  it("veredito que saiu do formulário exige escolher a opção equivalente", async () => {
    const current = structuredClone(row.context!);
    current.field_definition = { name: "x", type: "single", options: ["Sim", "Não"], description: "Pergunta" };
    mocks.prepare.mockResolvedValue({ context: current });
    show({ ...errorCase(), chosenVerdict: "Talvez" });
    await userEvent.click(screen.getByRole("button", { name: "Erro do LLM" }));
    await screen.findByRole("dialog");
    expect(screen.getByText(/saiu do formulário/)).toBeTruthy();
    const confirm = await screen.findByRole("button", { name: "Confirmar decisão" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "Não" }));
    await userEvent.click(confirm);
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith("p1", "doc1", "x", expect.objectContaining({
      decision: "researchers_correct", value: "Não",
    })));
  });

  it("membro sem can_resolve não recebe controles de decisão", () => {
    show(errorCase(), false);
    expect(screen.queryByRole("button", { name: "Erro humano" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Erro do LLM" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Em discussão" })).toBeNull();
  });
});
