// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { hydrateFromServerHtml } from "@/test-utils/hydration";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AutoReviewFooter } from "@/components/auto-review/AutoReviewFooter";

const HINTS_DISMISSED_KEY = "autoReview:hintsDismissed";

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

function footer() {
  return (
    <AutoReviewFooter
      readOnly={false}
      readyCount={1}
      incompleteCount={0}
      submitting={false}
      canSubmit={true}
      onSubmit={vi.fn()}
    />
  );
}

function renderFooter() {
  render(footer());
  return screen.getByRole("button", { name: /atalhos/i });
}

/**
 * O `localStorage.setItem` saiu de dentro do updater de `setHintsOpen`
 * (react-doctor `no-impure-state-updater`, 0.7.8): React pode reexecutar o
 * updater e o efeito colateral repetiria. A persistência tem que continuar
 * acontecendo exatamente uma vez, e só ao FECHAR.
 */
describe("AutoReviewFooter — persistência do painel de atalhos", () => {
  it("grava a dispensa ao fechar e não grava ao reabrir", async () => {
    const user = userEvent.setup();
    const toggle = renderFooter();

    // Começa aberto (nada dispensado ainda): o primeiro clique fecha e grava.
    await user.click(toggle);
    expect(window.localStorage.getItem(HINTS_DISMISSED_KEY)).toBe("1");

    // Reabrir não pode desfazer nem regravar — a chave é "já foi dispensado
    // uma vez", não o estado corrente do painel.
    window.localStorage.removeItem(HINTS_DISMISSED_KEY);
    await user.click(toggle);
    expect(window.localStorage.getItem(HINTS_DISMISSED_KEY)).toBeNull();
  });

  it("começa fechado quando a dispensa já está persistida", () => {
    window.localStorage.setItem(HINTS_DISMISSED_KEY, "1");
    renderFooter();

    expect(screen.queryByText(/eu acertei/i)).toBeNull();
  });

  it("começa aberto quando não há dispensa persistida", () => {
    renderFooter();

    expect(screen.queryByText(/eu acertei/i)).not.toBeNull();
  });
});

/**
 * O servidor não tem `localStorage` e renderiza o painel fechado. Se o primeiro
 * render do cliente lesse o storage (lazy initializer com `typeof window`),
 * quem nunca dispensou os atalhos hidratava com o painel aberto sobre o HTML
 * fechado (react-doctor `no-hydration-branch-on-browser-global`, 0.9.22).
 */
describe("AutoReviewFooter — hidratação", () => {
  it("hidrata sem divergência e abre os atalhos depois, sem dispensa salva", async () => {
    const { container, hydrationErrors } = await hydrateFromServerHtml(footer(), {
      serverWithoutWindow: true,
    });

    expect(hydrationErrors).toEqual([]);
    expect(container.textContent).toContain("Eu acertei");
  });

  it("hidrata sem divergência e segue fechado com a dispensa salva", async () => {
    window.localStorage.setItem(HINTS_DISMISSED_KEY, "1");
    const { container, hydrationErrors } = await hydrateFromServerHtml(footer(), {
      serverWithoutWindow: true,
    });

    expect(hydrationErrors).toEqual([]);
    expect(container.textContent).not.toContain("Eu acertei");
  });
});
