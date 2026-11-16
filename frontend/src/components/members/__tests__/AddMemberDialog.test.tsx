// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  addMember: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/actions/members", () => ({ addMember: mocks.addMember }));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { AddMemberDialog } from "@/components/members/AddMemberDialog";
import { maskedServerError } from "@/test-utils/masked-server-error";
import { ACTION_TIMEOUT_MESSAGE, ACTION_TIMEOUT_MS } from "@/lib/action-timeout";

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  // A rejeição é logada antes do toast; silencia a saída no teste.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function submitMember() {
  const user = userEvent.setup();
  render(<AddMemberDialog projectId="project-1" />);
  await user.click(screen.getByRole("button", { name: "Adicionar Membro" }));
  await user.type(screen.getByPlaceholderText("Email"), "ana@example.com");
  await user.click(screen.getByRole("button", { name: "Adicionar" }));
}

describe("AddMemberDialog", () => {
  it("adiciona o membro e confirma com toast", async () => {
    mocks.addMember.mockResolvedValue({});

    await submitMember();

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Membro adicionado!"),
    );
    expect(mocks.addMember).toHaveBeenCalledWith(
      "project-1",
      "ana@example.com",
      "pesquisador",
    );
  });

  it("pré-registra quem ainda não tem conta e fecha o diálogo", async () => {
    mocks.addMember.mockResolvedValue({ pending: true });

    await submitMember();

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Membro pré-registrado. Ele entrará no projeto ao criar conta com este e-mail.",
      ),
    );
    await waitFor(() => expect(screen.queryByPlaceholderText("Email")).toBeNull());
  });

  it("mostra o erro retornado pela action e mantém o diálogo", async () => {
    mocks.addMember.mockResolvedValue({ error: "Usuário já é membro deste projeto." });

    await submitMember();

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Usuário já é membro deste projeto."),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("Email") as HTMLInputElement).value).toBe(
      "ana@example.com",
    );
  });

  it("libera o botão e informa erro quando a action rejeita", async () => {
    mocks.addMember.mockRejectedValue(maskedServerError());

    await submitMember();

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Não foi possível adicionar o membro. Tente novamente. — código 1bkm1w6",
      ),
    );
    expect(console.error).toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Adicionar" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    // O diálogo segue aberto com o e-mail digitado, para tentar de novo.
    expect((screen.getByPlaceholderText("Email") as HTMLInputElement).value).toBe(
      "ana@example.com",
    );
  });

  it("libera o botão e avisa quando a action nunca responde", async () => {
    mocks.addMember.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<AddMemberDialog projectId="project-1" />);
    await user.click(screen.getByRole("button", { name: "Adicionar Membro" }));
    await user.type(screen.getByPlaceholderText("Email"), "ana@example.com");
    const button = screen.getByRole("button", { name: "Adicionar" });
    // Só o prazo do envio corre em relógio falso; o diálogo abre no real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(button);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS));

    expect(mocks.toastError).toHaveBeenCalledWith(ACTION_TIMEOUT_MESSAGE);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByPlaceholderText("Email") as HTMLInputElement).value).toBe(
      "ana@example.com",
    );
  });
});
