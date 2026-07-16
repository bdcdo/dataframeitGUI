// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaEditorBanners } from "../SchemaEditorBanners";

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
