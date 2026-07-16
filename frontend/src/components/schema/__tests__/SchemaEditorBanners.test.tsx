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
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "O rascunho local da outra aba foi preservado",
    );
  });
});
