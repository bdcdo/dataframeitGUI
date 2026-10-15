// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { SchemaEditorBanners } from "../SchemaEditorBanners";

// Este arquivo só usa fireEvent, mas o primeiro teste pagava sozinho o
// primeiro render e a primeira consulta de React DOM e Testing Library, a frio,
// e com a suíte disputando a CPU custava várias vezes o que custam os testes
// seguintes. O aquecimento carrega também user-event e Radix, que o arquivo
// não usa; mesmo com esse custo a mais, o primeiro teste cai para menos da
// metade (src/test-utils/jsdom-warm-up.tsx).
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
