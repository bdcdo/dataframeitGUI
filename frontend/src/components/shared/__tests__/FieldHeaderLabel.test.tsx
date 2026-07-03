// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { FieldHeaderLabel } from "@/components/shared/FieldHeaderLabel";

afterEach(cleanup);

describe("FieldHeaderLabel", () => {
  it("renders the prefix and description", () => {
    render(
      <FieldHeaderLabel prefix="Campo 1/3:">Data do parecer</FieldHeaderLabel>,
    );
    expect(screen.getByText("Campo 1/3:")).toBeTruthy();
    expect(screen.getByText("Data do parecer")).toBeTruthy();
  });

  it("renders help text when present", () => {
    render(
      <FieldHeaderLabel prefix="Campo 1/3:" helpText="Considere apenas o dispositivo final.">
        Data do parecer
      </FieldHeaderLabel>,
    );
    expect(
      screen.getByText("Considere apenas o dispositivo final."),
    ).toBeTruthy();
  });

  it("renders nothing extra when help text is absent", () => {
    const { container } = render(
      <FieldHeaderLabel prefix="Campo 1/3:">Data do parecer</FieldHeaderLabel>,
    );
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("renders nothing extra when help text is an empty string", () => {
    const { container } = render(
      <FieldHeaderLabel prefix="Campo 1/3:" helpText="">
        Data do parecer
      </FieldHeaderLabel>,
    );
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("bounds the help text block height with the provided className", () => {
    render(
      <FieldHeaderLabel
        prefix="Campo 1/3:"
        helpText="Texto longo de orientação para o pesquisador."
        helpTextClassName="max-h-28 overflow-y-auto"
      >
        Data do parecer
      </FieldHeaderLabel>,
    );
    const helpText = screen.getByText(
      "Texto longo de orientação para o pesquisador.",
    );
    expect(helpText.className).toContain("max-h-28");
    expect(helpText.className).toContain("overflow-y-auto");
  });
});
