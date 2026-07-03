// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  OutOfScopeToggle,
  type OutOfScopeState,
} from "@/components/coding/OutOfScopeToggle";

const hoisted = vi.hoisted(() => ({
  request: vi.fn(async () => ({ success: true }) as { success?: boolean; error?: string }),
  cancel: vi.fn(async () => ({ success: true }) as { success?: boolean; error?: string }),
  refresh: vi.fn(),
}));

vi.mock("@/actions/project-comments", () => ({
  requestDocumentExclusion: (...a: unknown[]) => hoisted.request(...(a as [])),
  cancelExclusionRequest: (...a: unknown[]) => hoisted.cancel(...(a as [])),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: hoisted.refresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(cleanup);
beforeEach(() => {
  hoisted.request.mockClear().mockResolvedValue({ success: true });
  hoisted.cancel.mockClear().mockResolvedValue({ success: true });
  hoisted.refresh.mockClear();
});

function renderToggle(
  state: OutOfScopeState,
  onStateChange = vi.fn(),
  disabled = false,
) {
  render(
    <OutOfScopeToggle
      projectId="p1"
      documentId="d1"
      documentTitle="Doc Um"
      state={state}
      onStateChange={onStateChange}
      disabled={disabled}
    />,
  );
  return onStateChange;
}

describe("OutOfScopeToggle — três estados", () => {
  it("normal: switch desligado, texto explicativo, sem pedido em voo", () => {
    renderToggle({ status: "normal" });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/sai das\s+filas de todos/i)).toBeTruthy();
  });

  it("pending_mine: switch ligado, mostra justificativa e permite desfazer", () => {
    renderToggle({ status: "pending_mine", reason: "medicamento diferente" });
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect((sw as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/medicamento diferente/)).toBeTruthy();
    expect(screen.getByText(/Aguardando revisão do coordenador/)).toBeTruthy();
  });

  it("pending_other: switch ligado e desabilitado", () => {
    renderToggle({ status: "pending_other" });
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/outro pesquisador/)).toBeTruthy();
  });
});

describe("OutOfScopeToggle — sinalizar", () => {
  it("ligar abre o dialog; confirmar exige justificativa e chama a action", async () => {
    const user = userEvent.setup();
    const onChange = renderToggle({ status: "normal" });

    await user.click(screen.getByRole("switch"));
    // Dialog aberto, botão de confirmação desabilitado sem justificativa.
    const confirm = screen.getByRole("button", {
      name: /Sinalizar fora de escopo/,
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    await user.type(
      screen.getByLabelText(/Por que está fora do escopo/),
      "não trata do medicamento",
    );
    await user.click(confirm);

    expect(hoisted.request).toHaveBeenCalledWith(
      "p1",
      "d1",
      "não trata do medicamento",
    );
    expect(onChange).toHaveBeenCalledWith({
      status: "pending_mine",
      reason: "não trata do medicamento",
    });
    expect(hoisted.refresh).toHaveBeenCalled();
  });

  it("erro da action não muda o estado", async () => {
    hoisted.request.mockResolvedValue({ error: "já está em revisão" });
    const user = userEvent.setup();
    const onChange = renderToggle({ status: "normal" });

    await user.click(screen.getByRole("switch"));
    await user.type(
      screen.getByLabelText(/Por que está fora do escopo/),
      "motivo",
    );
    await user.click(
      screen.getByRole("button", { name: /Sinalizar fora de escopo/ }),
    );

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("OutOfScopeToggle — desfazer", () => {
  it("desligar em pending_mine cancela o pedido", async () => {
    const user = userEvent.setup();
    const onChange = renderToggle({
      status: "pending_mine",
      reason: "motivo",
    });

    await user.click(screen.getByRole("switch"));

    expect(hoisted.cancel).toHaveBeenCalledWith("p1", "d1");
    expect(onChange).toHaveBeenCalledWith({ status: "normal" });
    expect(hoisted.refresh).toHaveBeenCalled();
  });

  it("disabled (readOnly) não dispara nada", async () => {
    const user = userEvent.setup();
    const onChange = renderToggle({ status: "normal" }, vi.fn(), true);

    await user.click(screen.getByRole("switch"));

    expect(hoisted.request).not.toHaveBeenCalled();
    expect(hoisted.cancel).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
