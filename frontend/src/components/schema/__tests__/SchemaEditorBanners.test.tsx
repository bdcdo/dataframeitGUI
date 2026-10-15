// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { SchemaEditorBanners } from "../SchemaEditorBanners";

// O primeiro teste deste arquivo pagava o carregamento a frio de React DOM,
// Testing Library, user-event e Radix e estourava os 5 s com a suíte
// disputando a CPU (src/test-utils/jsdom-warm-up.tsx).
beforeAll(() => warmUpJsdom(), 30_000);

afterEach(cleanup);

describe("SchemaEditorBanners", () => {
  it("avisa sem sobrescrever quando outra aba possui o rascunho", () => {
    render(
      <SchemaEditorBanners
        helpDismissed
        onDismissHelp={() => {}}
        canRecover={false}
        onRecover={() => {}}
        isPending={false}
        storageBlocked
        staleDraftDiscarded={false}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "O rascunho local da outra aba foi preservado",
    );
  });

  it("anuncia o rascunho que ficou ilegível em vez de descartá-lo calado", () => {
    render(
      <SchemaEditorBanners
        helpDismissed
        onDismissHelp={() => {}}
        canRecover={false}
        onRecover={() => {}}
        isPending={false}
        storageBlocked={false}
        staleDraftDiscarded
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Um rascunho anterior não pôde ser recuperado",
    );
  });

  it("não anuncia perda alguma quando não houve rascunho ilegível", () => {
    render(
      <SchemaEditorBanners
        helpDismissed
        onDismissHelp={() => {}}
        canRecover={false}
        onRecover={() => {}}
        isPending={false}
        storageBlocked={false}
        staleDraftDiscarded={false}
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
