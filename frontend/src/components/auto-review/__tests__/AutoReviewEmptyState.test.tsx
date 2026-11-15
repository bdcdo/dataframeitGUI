// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { AutoReviewEmptyState } from "../AutoReviewEmptyState";

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

afterEach(cleanup);

async function renderEmpty(docsWithoutLlm?: number | null) {
  // A rota manda a contagem como promessa (streaming); aqui ela já resolveu.
  await act(async () => {
    render(
      <AutoReviewEmptyState
        readOnly={false}
        isCoordinator
        reviewers={[]}
        queueUserId="u1"
        ownQueueUserId="u1"
        onViewAsChange={vi.fn()}
        docsWithoutLlm={docsWithoutLlm === undefined ? undefined : Promise.resolve(docsWithoutLlm)}
      />,
    );
  });
}

// #889: a fila vazia depois de um round reiniciado precisa dizer por quê.
describe("AutoReviewEmptyState — documentos sem geração LLM", () => {
  it("explica a fila vazia com a contagem de documentos sem geração LLM corrente", async () => {
    await renderEmpty(3);
    const note = (await screen.findByRole("note")).textContent;
    expect(note).toContain(
      "3 documento(s) com codificação humana estão fora da auto-revisão por não ter geração LLM corrente",
    );
    // A contagem é do projeto inteiro: com o viewAs, a fila exibida é de um
    // pesquisador só, e "aqui" prometeria divergências que nunca chegam nela.
    expect(note).toContain("No projeto,");
    expect(note).not.toContain("aqui");
  });

  it("avisa quando não foi possível contar, em vez de calar", async () => {
    await renderEmpty(null);
    expect((await screen.findByRole("note")).textContent).toContain(
      "Não foi possível verificar",
    );
  });

  it("sem documento de fora, não mostra aviso", async () => {
    await renderEmpty(0);
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
    await renderEmpty(undefined);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
