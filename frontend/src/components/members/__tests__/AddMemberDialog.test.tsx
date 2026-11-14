// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

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

  it("libera o botão e informa erro quando a action rejeita", async () => {
    mocks.addMember.mockRejectedValue(new Error("network failure"));

    await submitMember();

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Não foi possível adicionar o membro. Tente novamente.",
      ),
    );
    const button = screen.getByRole("button", { name: "Adicionar" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
