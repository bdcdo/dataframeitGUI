// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorDecisionDialog } from "@/components/stats/ErrorDecisionDialog";
import { resolutionFixture } from "@/lib/__tests__/error-resolution-fixture";
import type { LlmError } from "@/lib/llm-error-metrics";
import type { ErrorResolutionContext } from "@/lib/error-resolution";

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
function show(field: unknown, chosenVerdict: string, extra: Partial<LlmError> = {}) {
  const onConfirm = vi.fn();
  render(<ErrorDecisionDialog
    pending={{ error: errorCase(chosenVerdict, extra), decision: "researchers_correct", context: { ...base.context!, field_definition: field as ErrorResolutionContext["field_definition"] } }}
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

  it("multi: opção do veredito que saiu do formulário avisa, em vez de sumir calada", () => {
    show({ name: "x", type: "multi", options: ["A", "B", "C"], description: "P" }, '{"A":true,"Z":true}');
    expect(checked("checkbox", "A")).toBe(true);
    expect(screen.getByText(/Parte dessa resposta saiu do formulário/)).toBeTruthy();
  });

  it("auto-revisão: item do snapshot humano que saiu do formulário também avisa", () => {
    // Aqui o veredito exibido é texto ("A, Z"), e o valor inicial vem da forma crua.
    show({ name: "x", type: "multi", options: ["A", "B", "C"], description: "P" }, "A, Z", { source: "auto_revisao", chosenValue: ["A", "Z"] });
    expect(checked("checkbox", "A")).toBe(true);
    expect(screen.getByText(/Parte dessa resposta saiu do formulário/)).toBeTruthy();
  });

  it("multi com Outro: o complemento do veredito chega ao seletor e ao valor confirmado", async () => {
    const onConfirm = show({ name: "x", type: "multi", options: ["A", "B"], description: "P", allow_other: true },
      '{"A":true,"Outro: livre":true}');
    expect(checked("checkbox", "A")).toBe(true);
    // O revisor vê o complemento que vai confirmar: o estado sozinho não prova isso.
    expect(checked("checkbox", "Outro:")).toBe(true);
    expect((screen.getByPlaceholderText("Digite o valor...") as HTMLInputElement).value).toBe("livre");
    expect(screen.queryByText(/saiu do formulário/)).toBeNull();
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("", ["A", "Outro: livre"]);
  });

  it("single com Outro: o veredito 'Outro: <texto>' não é tratado como resposta que saiu do formulário", async () => {
    const onConfirm = show({ name: "x", type: "single", options: ["A"], description: "P", allow_other: true }, "Outro: livre");
    expect(screen.queryByText(/saiu do formulário/)).toBeNull();
    expect(checked("radio", "Outro:")).toBe(true);
    expect((screen.getByPlaceholderText("Digite o valor...") as HTMLInputElement).value).toBe("livre");
    expect(confirmButton().disabled).toBe(false);
    await userEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith("", "Outro: livre");
  });

  it("single sem allow_other: 'Outro: <texto>' segue fora do formulário", () => {
    show({ name: "x", type: "single", options: ["A"], description: "P" }, "Outro: livre");
    expect(screen.getByText(/Essa resposta saiu do formulário/)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
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
