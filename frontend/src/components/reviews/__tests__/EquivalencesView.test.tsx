// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EquivalencesView } from "@/components/reviews/EquivalencesView";
import type { EquivalenceFieldView } from "@/lib/reviews/equivalences-view-model";

const { refresh, unmarkEquivalencePair, loadEquivalenceUsage, toastSuccess, toastError } = vi.hoisted(() => ({
  refresh: vi.fn(),
  unmarkEquivalencePair: vi.fn(async (): Promise<{ error?: string }> => ({})),
  loadEquivalenceUsage: vi.fn(async (): Promise<{ usage?: Record<string, Array<{ id: string; title: string }>>; error?: string }> => ({ usage: {} })),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/actions/equivalences", () => ({ unmarkEquivalencePair, loadEquivalenceUsage }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));

beforeAll(() => warmUpJsdom(), 30_000);
beforeEach(() => {
  refresh.mockClear();
  unmarkEquivalencePair.mockClear();
  loadEquivalenceUsage.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});
afterEach(cleanup);

const FIELDS: EquivalenceFieldView[] = [{
  name: "q6",
  label: "Data de nascimento",
  classes: [{
    classKey: "k1",
    values: [{ key: "k-a", display: "Não informada" }, { key: "k-b", display: "NI" }],
    equivalences: [
      { id: "e1", display: "Não informada = NI", reviewerName: "ana", createdAt: "2026-11-01T12:00:00Z", sourceLabel: "Comparação", canUndo: true },
      { id: "e2", display: "NI = N/A", reviewerName: "bia", createdAt: null, sourceLabel: "Auto-revisão", canUndo: false },
    ],
  }],
}];

describe("EquivalencesView", () => {
  it("sem equivalência, explica onde marcar", () => {
    render(<EquivalencesView projectId="p1" fields={[]} history={[]} />);
    expect(screen.getByText(/Nenhuma equivalência na versão atual/)).toBeTruthy();
  });

  it("desfazer pede confirmação, chama a action e recarrega; só aparece para quem pode", async () => {
    const user = userEvent.setup();
    render(<EquivalencesView projectId="p1" fields={FIELDS} history={[]} />);

    expect(screen.getByText("2 equivalências em 1 campo.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Desfazer a equivalência/ })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Desfazer a equivalência Não informada = NI" }));
    expect(screen.getByText(/Nenhum veredito é apagado/)).toBeTruthy();
    expect(unmarkEquivalencePair).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect(unmarkEquivalencePair).toHaveBeenCalledWith("p1", "e1"));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(toastSuccess).toHaveBeenCalledOnce();
  });

  it("falha ao desfazer mostra o erro e não recarrega", async () => {
    unmarkEquivalencePair.mockResolvedValueOnce({ error: "sem permissão" });
    const user = userEvent.setup();
    render(<EquivalencesView projectId="p1" fields={FIELDS} history={[]} />);

    await user.click(screen.getByRole("button", { name: "Desfazer a equivalência Não informada = NI" }));
    await user.click(screen.getByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("sem permissão"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("onde se aplica carrega sob demanda e lista os documentos com link para a Comparação", async () => {
    loadEquivalenceUsage.mockResolvedValueOnce({ usage: { k1: [{ id: "d1", title: "Nota 1" }] } });
    const user = userEvent.setup();
    render(<EquivalencesView projectId="p1" fields={FIELDS} history={[]} />);

    expect(loadEquivalenceUsage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Onde se aplica" }));
    expect(loadEquivalenceUsage).toHaveBeenCalledWith("p1", "q6");

    await user.click(await screen.findByRole("button", { name: /Funde respostas em 1 documento/ }));
    expect(screen.getByRole("link", { name: "Nota 1" }).getAttribute("href")).toBe("/projects/p1/analyze/compare?doc=d1");
  });

  // Depois de desfazer, o refresh traz as classes novas: a seção remonta e
  // "onde se aplica" volta a ser carregável, em vez de ficar com o mapa velho.
  it("onde se aplica volta a ser carregável quando as equivalências do campo mudam", async () => {
    loadEquivalenceUsage.mockResolvedValue({ usage: { k1: [{ id: "d1", title: "Nota 1" }] } });
    const user = userEvent.setup();
    const { rerender } = render(<EquivalencesView projectId="p1" fields={FIELDS} history={[]} />);
    await user.click(screen.getByRole("button", { name: "Onde se aplica" }));
    await screen.findByRole("button", { name: /Funde respostas em 1 documento/ });
    expect((screen.getByRole("button", { name: "Onde se aplica" }) as HTMLButtonElement).disabled).toBe(true);

    const afterUndo: EquivalenceFieldView[] = [{
      ...FIELDS[0],
      classes: [{ ...FIELDS[0].classes[0], equivalences: [FIELDS[0].classes[0].equivalences[1]] }],
    }];
    rerender(<EquivalencesView projectId="p1" fields={afterUndo} history={[]} />);
    expect((screen.getByRole("button", { name: "Onde se aplica" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /Funde respostas/ })).toBeNull();
    loadEquivalenceUsage.mockReset();
    loadEquivalenceUsage.mockResolvedValue({ usage: {} });
  });

  it("histórico recolhido com o motivo", async () => {
    const user = userEvent.setup();
    render(
      <EquivalencesView
        projectId="p1"
        fields={[]}
        history={[{ id: "h1", fieldLabel: "Data", display: "a = b", reasonLabel: "Pergunta alterada", supersededAt: "2026-11-02T00:00:00Z", reviewerName: "ana" }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Histórico \(1\)/ }));
    expect(screen.getByText("Pergunta alterada")).toBeTruthy();
  });
});
