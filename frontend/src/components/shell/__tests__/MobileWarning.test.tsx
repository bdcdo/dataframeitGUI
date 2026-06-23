// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MobileWarning } from "@/components/shell/MobileWarning";

// jsdom não implementa a API de <dialog> (showModal/close); browsers reais sim
// (suporte universal desde ~2022). Polyfill mínimo que apenas reflete o atributo
// `open` para o ambiente de teste — não roda em browser real (feature-detect).
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

afterEach(() => {
  cleanup();
  setViewportWidth(1024);
});

describe("MobileWarning", () => {
  it("não abre o dialog em telas largas", () => {
    setViewportWidth(1280);
    render(<MobileWarning />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("abre o dialog (showModal) em telas estreitas e o botão dispensa", async () => {
    const user = userEvent.setup();
    setViewportWidth(500);
    render(<MobileWarning />);

    const dialog = screen.getByRole("dialog", { name: "Use um computador" });
    expect((dialog as HTMLDialogElement).open).toBe(true);

    await user.click(
      screen.getByRole("button", { name: /continuar mesmo assim/i }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
