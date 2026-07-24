// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";

afterEach(cleanup);

// O fechamento é do pai: quem chama decide se a confirmação encerrou o fluxo.
// Sem isso, `isPending`/`pendingLabel` seriam inalcançáveis e a validação que
// recusa confirmar (ExcludeDocumentsDialog sem motivo) descartaria o que o
// usuário já tinha digitado.
function Harness({
  onConfirm,
  isPending = false,
}: {
  onConfirm: () => void;
  isPending?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmActionDialog
      open={open}
      onClose={() => setOpen(false)}
      title="Remover?"
      description="Descrição da ação."
      confirmLabel="Remover"
      pendingLabel="Removendo…"
      destructive
      isPending={isPending}
      onConfirm={onConfirm}
    />
  );
}

describe("ConfirmActionDialog", () => {
  it("mantém o diálogo aberto quando o pai não fecha na confirmação", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Remover" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("fecha quando o pai fecha, e o cancelar sempre encerra", async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("exibe o estado pendente e desabilita as duas saídas", () => {
    render(<Harness onConfirm={() => {}} isPending />);

    const confirm = screen.getByRole("button", { name: "Removendo…" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Cancelar" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
