// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { AutoReviewEmptyState } from "../AutoReviewEmptyState";

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

afterEach(cleanup);

function renderEmpty(docsWithoutLlm?: number | null) {
  render(
    <AutoReviewEmptyState
      readOnly={false}
      isCoordinator
      reviewers={[]}
      queueUserId="u1"
      ownQueueUserId="u1"
      onViewAsChange={vi.fn()}
      docsWithoutLlm={docsWithoutLlm}
    />,
  );
}

// #889: a fila vazia depois de um round reiniciado precisa dizer por quê.
describe("AutoReviewEmptyState — documentos sem geração LLM", () => {
  it("explica a fila vazia com a contagem de documentos sem geração LLM corrente", () => {
    renderEmpty(3);
    expect(screen.getByRole("note").textContent).toContain(
      "3 documento(s) com codificação humana estão fora da auto-revisão por não ter geração LLM corrente",
    );
  });

  it("avisa quando não foi possível contar, em vez de calar", () => {
    renderEmpty(null);
    expect(screen.getByRole("note").textContent).toContain(
      "Não foi possível verificar",
    );
  });

  it("sem documento de fora, não mostra aviso", () => {
    renderEmpty(0);
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
    renderEmpty(undefined);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
