// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorDecisionDialog } from "@/components/stats/ErrorDecisionDialog";
import { resolutionFixture } from "@/lib/__tests__/error-resolution-fixture";
import type { LlmError } from "@/lib/llm-error-metrics";
import type { ErrorDecision, ErrorResolutionContext } from "@/lib/error-resolution";

// O seletor de "Erro do LLM" por tipo de campo (#733). Texto e `single`
// pré-marcado passam pela view (LlmInsightsView.test.tsx); aqui ficam os tipos
// e estados que só o diálogo decide.
const base = resolutionFixture("researchers_correct");
function errorCase(chosenVerdict: string, extra: Partial<LlmError> = {}): LlmError {
  return { documentId: "doc1", documentTitle: "Documento", fieldName: "x", fieldDescription: "Pergunta",
    llmAnswer: "LLM", llmJustification: null, chosenVerdict, reviewerComment: null,
    resolvedAt: null, reviewedAt: "2026-09-14T12:00:00Z", schemaVersion: null,
    llmResponseId: "rllm", chosenResponseId: "rh", source: "comparacao", sourceId: "review1", ...extra };
}
function show(field: unknown, chosenVerdict: string, extra: Partial<LlmError> = {}, decision: ErrorDecision = "researchers_correct") {
  const onConfirm = vi.fn();
  render(<ErrorDecisionDialog
    pending={{ error: errorCase(chosenVerdict, extra), decision, context: { ...base.context!, field_definition: field as ErrorResolutionContext["field_definition"] } }}
    isPending={false} onClose={() => {}} onConfirm={onConfirm} />);
  return onConfirm;
}
const confirmButton = () => screen.getByRole("button", { name: "Confirmar decisão" }) as HTMLButtonElement;
const checked = (role: "radio" | "checkbox", name: string) => (screen.getByRole(role, { name }) as HTMLInputElement).checked;

afterEach(cleanup);

describe("ErrorDecisionDialog — Erro do LLM leva o veredito nas opções atuais (#733)", () => {
  it("multi: pré-marca as opções do veredito que ainda existem e envia array", async () => {
    const onConfirm = show({ name: "x", type: "multi", options: ["A", "B", "C"], description: "P" }, '{"A":true,"C":true,"Z":true}');
    expect(checked("checkbox", "A")).toBe(true);
    expect(checked("checkbox", "B")).toBe(false);
    expect(checked("checkbox", "C")).toBe(true);
    expect(confirmButton().disabled).toBe(false);
    await userEvent.click(screen.getByRole("checkbox", { name: "B" }));
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("", ["A", "C", "B"]);
  });

  it("multi: veredito sem opção atual não pré-marca e bloqueia até marcar", async () => {
    const onConfirm = show({ name: "x", type: "multi", options: ["A", "B"], description: "P" }, '{"Z":true}');
    expect(screen.getByText(/saiu do formulário/)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "A" }));
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("", ["A"]);
  });

  it("single: veredito com espaço a menos casa com a opção atual por trim", () => {
    show({ name: "x", type: "single", options: ["Incorporado ", "Não incorporado"], description: "P" }, "Incorporado");
    expect(checked("radio", "Incorporado")).toBe(true);
    expect(screen.queryByText(/saiu do formulário/)).toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });

  it("subcampos: um input por subcampo, sem pré-preenchimento, envia objeto", async () => {
    const onConfirm = show({ name: "x", type: "text", options: null, description: "P",
      subfields: [{ key: "anos", label: "Anos" }, { key: "meses", label: "Meses" }] }, "anos: 2");
    expect(confirmButton().disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Anos"), "2");
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("", { anos: "2" });
  });

  it("a nota acompanha o valor", async () => {
    const onConfirm = show({ name: "x", type: "text", options: null, description: "P" }, "livre");
    await userEvent.type(screen.getByLabelText("Nota opcional"), "ok");
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("ok", "livre");
  });

  it("redecidir parte do valor já aprovado, não do veredito que saiu do formulário", async () => {
    const resolution = { ...base, approved_value: "Não" };
    const onConfirm = show({ name: "x", type: "single", options: ["Sim", "Não"], description: "P" }, "Talvez", { resolution });
    expect(checked("radio", "Não")).toBe(true);
    expect(screen.queryByText(/saiu do formulário/)).toBeNull();
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("Conferido", "Não");
  });

  it("multi votado em card na Comparação ('A, C') pré-marca pela resposta escolhida", () => {
    show({ name: "x", type: "multi", options: ["A", "B", "C"], description: "P" }, "A, C", { chosenValue: ["A", "C"] });
    expect(checked("checkbox", "A")).toBe(true);
    expect(checked("checkbox", "C")).toBe(true);
    expect(screen.queryByText(/saiu do formulário/)).toBeNull();
  });

  it("o texto do veredito vence a forma crua quando os dois existem", () => {
    show({ name: "x", type: "single", options: ["Sim", "Não"], description: "P" }, "Não", { chosenValue: "Sim" });
    expect(checked("radio", "Não")).toBe(true);
  });

  it("auto-revisão: o snapshot humano cru pré-marca o multi (o veredito exibido é texto)", () => {
    show({ name: "x", type: "multi", options: ["A", "B", "C"], description: "P" }, "A, C", { source: "auto_revisao", chosenValue: ["A", "C"] });
    expect(checked("checkbox", "A")).toBe(true);
    expect(checked("checkbox", "B")).toBe(false);
    expect(checked("checkbox", "C")).toBe(true);
    expect(screen.queryByText(/saiu do formulário/)).toBeNull();
  });

  it("veredito 'ambiguo' não vira resposta pré-preenchida", () => {
    show({ name: "x", type: "text", options: null, description: "P" }, "ambiguo");
    expect((screen.getByPlaceholderText("Digite sua resposta...") as HTMLTextAreaElement).value).toBe("");
    expect(confirmButton().disabled).toBe(true);
  });

  it("definição ilegível não deixa confirmar", () => {
    show({ name: "x", type: "bogus" }, "x");
    expect(screen.getByText(/não pôde ser lida/)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
  });
});

const yesNo = { name: "x", type: "single", options: ["Sim", "Não", "Talvez"], description: "P" };

describe("ErrorDecisionDialog — Todos errados", () => {
  it("não pré-marca o veredito, que é o que está sendo rejeitado, e bloqueia até escolher", async () => {
    const onConfirm = show(yesNo, "Sim", {}, "all_wrong");
    expect(screen.getByRole("heading", { name: "Todos errados" })).toBeTruthy();
    expect(checked("radio", "Sim")).toBe(false);
    expect(screen.getByText(/Nem esta resposta nem a do LLM/)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "Talvez" }));
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("", "Talvez");
  });

  it("redecidir Todos errados parte do valor que a própria decisão aprovou", () => {
    const resolution = { ...resolutionFixture("all_wrong"), approved_value: "Talvez" };
    show(yesNo, "Sim", { resolution }, "all_wrong");
    expect(checked("radio", "Talvez")).toBe(true);
  });

  it("valor aprovado em Erro do LLM não migra para Todos errados, nem o contrário", () => {
    show(yesNo, "Sim", { resolution: { ...base, approved_value: "Não" } }, "all_wrong");
    expect(checked("radio", "Não")).toBe(false);
    cleanup();
    show(yesNo, "Sim", { resolution: { ...resolutionFixture("all_wrong"), approved_value: "Talvez" } });
    expect(checked("radio", "Sim")).toBe(true);
  });
});

describe("ErrorDecisionDialog — Ambos corretos", () => {
  it("mostra o veredito que segue no gabarito, sem seletor, e confirma só com a nota", async () => {
    const onConfirm = show(yesNo, "Sim", {}, "both_correct");
    expect(screen.getByRole("heading", { name: "Ambos corretos" })).toBeTruthy();
    expect(screen.getByText(/continua sendo o veredito anterior/)).toBeTruthy();
    expect(screen.getByText("Sim")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    await userEvent.type(screen.getByLabelText("Nota opcional"), "sinônimos");
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("sinônimos");
  });

  it("sem resposta do LLM no campo não há o que declarar correto", () => {
    const onConfirm = vi.fn();
    render(<ErrorDecisionDialog
      pending={{ error: errorCase("Sim"), decision: "both_correct",
        context: { ...base.context!, llm_value: { present: false, value: null } } }}
      isPending={false} onClose={() => {}} onConfirm={onConfirm} />);
    expect(confirmButton().disabled).toBe(true);
  });
});
