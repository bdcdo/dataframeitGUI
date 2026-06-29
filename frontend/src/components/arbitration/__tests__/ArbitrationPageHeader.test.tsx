// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ArbitrationPageHeader } from "../ArbitrationPageHeader";

afterEach(cleanup);

type Props = Parameters<typeof ArbitrationPageHeader>[0];

function renderHeader(overrides: Partial<Props> = {}) {
  const props: Props = {
    phase: "blind",
    docIndex: 0,
    docsLength: 3,
    submitting: false,
    allBlindChosen: true,
    allFinalChosen: true,
    onNavigate: vi.fn(),
    onBackToBlind: vi.fn(),
    onBlindSubmit: vi.fn(),
    onFinalSubmit: vi.fn(),
    ...overrides,
  };
  render(<ArbitrationPageHeader {...props} />);
  return props;
}

describe("ArbitrationPageHeader — fase e contagem", () => {
  it("fase blind: badge 'Cega', botão 'Avançar para revelação' e sem 'Voltar à cega'", () => {
    renderHeader({ phase: "blind" });
    expect(screen.getByText("Cega")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Avançar para revelação" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Voltar à cega" }),
    ).toBeNull();
  });

  it("fase reveal: badge 'Revelação', botões 'Voltar à cega' e 'Enviar arbitragem'", () => {
    renderHeader({ phase: "reveal" });
    expect(screen.getByText("Revelação")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Voltar à cega" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Enviar arbitragem" }),
    ).toBeTruthy();
  });

  it("mostra a contagem de docs (plural e singular) e a posição atual", () => {
    renderHeader({ docIndex: 1, docsLength: 3 });
    expect(screen.getByText("3 docs")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();
    cleanup();
    renderHeader({ docsLength: 1, docIndex: 0 });
    expect(screen.getByText("1 doc")).toBeTruthy();
  });
});

describe("ArbitrationPageHeader — navegação", () => {
  it("desabilita 'anterior' no primeiro doc e 'próximo' no último", () => {
    renderHeader({ docIndex: 0, docsLength: 3 });
    expect(
      (screen.getByTitle("Documento anterior") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTitle("Próximo documento") as HTMLButtonElement).disabled,
    ).toBe(false);
    cleanup();
    renderHeader({ docIndex: 2, docsLength: 3 });
    expect(
      (screen.getByTitle("Próximo documento") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("clicar em anterior/próximo chama onNavigate com índice ±1", () => {
    const props = renderHeader({ docIndex: 1, docsLength: 3 });
    fireEvent.click(screen.getByTitle("Documento anterior"));
    expect(props.onNavigate).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByTitle("Próximo documento"));
    expect(props.onNavigate).toHaveBeenCalledWith(2);
  });
});

describe("ArbitrationPageHeader — ações de submit", () => {
  it("clicar em 'Voltar à cega' chama onBackToBlind", () => {
    const props = renderHeader({ phase: "reveal" });
    fireEvent.click(screen.getByRole("button", { name: "Voltar à cega" }));
    expect(props.onBackToBlind).toHaveBeenCalledTimes(1);
  });

  it("submit cego desabilitado quando !allBlindChosen; habilitado dispara onBlindSubmit", () => {
    const blocked = renderHeader({ phase: "blind", allBlindChosen: false });
    expect(
      (
        screen.getByRole("button", {
          name: "Avançar para revelação",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    cleanup();
    const props = renderHeader({ phase: "blind", allBlindChosen: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Avançar para revelação" }),
    );
    expect(props.onBlindSubmit).toHaveBeenCalledTimes(1);
    expect(blocked.onBlindSubmit).not.toHaveBeenCalled();
  });

  it("submit final desabilitado quando !allFinalChosen; habilitado dispara onFinalSubmit", () => {
    renderHeader({ phase: "reveal", allFinalChosen: false });
    expect(
      (
        screen.getByRole("button", {
          name: "Enviar arbitragem",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    cleanup();
    const props = renderHeader({ phase: "reveal", allFinalChosen: true });
    fireEvent.click(screen.getByRole("button", { name: "Enviar arbitragem" }));
    expect(props.onFinalSubmit).toHaveBeenCalledTimes(1);
  });

  it("submitting mostra rótulos de progresso e desabilita os botões", () => {
    renderHeader({ phase: "blind", submitting: true });
    const blindBtn = screen.getByRole("button", {
      name: "Salvando…",
    }) as HTMLButtonElement;
    expect(blindBtn.disabled).toBe(true);
    cleanup();
    renderHeader({ phase: "reveal", submitting: true });
    const finalBtn = screen.getByRole("button", {
      name: "Enviando…",
    }) as HTMLButtonElement;
    expect(finalBtn.disabled).toBe(true);
  });
});
