// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CopyLinkButton } from "@/components/ui/CopyLinkButton";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(cleanup);

// `userEvent.setup()` instala o próprio stub de `navigator.clipboard`, então
// não adianta injetar um mock antes: lemos de volta pelo stub, o que ainda
// exercita o `writeText` real do componente.
async function copiedText() {
  return navigator.clipboard.readText();
}

/**
 * A URL absoluta é montada no clique, não no render: `window.location.origin`
 * durante o render faz o servidor emitir `""` e o cliente emitir a origin,
 * divergindo na hidratação (react-doctor `no-hydration-branch-on-browser-global`,
 * 0.7.8). O mesmo caminho precisa servir aos dois tipos de entrada, porque
 * `parecerUrl` aponta para fora do app.
 */
describe("CopyLinkButton — resolução da URL no clique", () => {
  it("absolutiza uma URL relativa contra a origin da página", async () => {
    const user = userEvent.setup();
    render(<CopyLinkButton url="/projects/p1/analyze/code?doc=d1" />);

    await user.click(screen.getByRole("button"));

    await waitFor(async () =>
      expect(await copiedText()).toBe(
        `${window.location.origin}/projects/p1/analyze/code?doc=d1`,
      ),
    );
  });

  it("deixa uma URL absoluta externa intacta", async () => {
    const user = userEvent.setup();
    const parecerUrl = "https://exemplo.org/pareceres/123.pdf";
    render(<CopyLinkButton url={parecerUrl} />);

    await user.click(screen.getByRole("button"));

    await waitFor(async () => expect(await copiedText()).toBe(parecerUrl));
  });
});
