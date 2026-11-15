// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  updatePendingMemberEmail: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/actions/members", () => ({
  updatePendingMemberEmail: mocks.updatePendingMemberEmail,
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { EditPendingEmailDialog } from "@/components/members/EditPendingEmailDialog";
import type { MemberRow } from "@/components/members/member-list-utils";
import { maskedServerError } from "@/test-utils/masked-server-error";

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
});

const member = {
  user_id: "member-1",
  profiles: { email: "errado@example.com" },
} as unknown as MemberRow;

function renderDialog() {
  const onOpenChange = vi.fn();
  render(
    <EditPendingEmailDialog
      projectId="project-1"
      member={member}
      open
      onOpenChange={onOpenChange}
    />,
  );
  return { onOpenChange };
}

describe("EditPendingEmailDialog", () => {
  it("corrige o e-mail e fecha o diálogo", async () => {
    mocks.updatePendingMemberEmail.mockResolvedValue({});
    const { onOpenChange } = renderDialog();

    await userEvent.setup().click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("E-mail corrigido."),
    );
    expect(mocks.updatePendingMemberEmail).toHaveBeenCalledWith(
      "project-1",
      "member-1",
      "errado@example.com",
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("libera o botão e informa erro quando a action rejeita", async () => {
    mocks.updatePendingMemberEmail.mockRejectedValue(maskedServerError());
    const { onOpenChange } = renderDialog();

    await userEvent.setup().click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Não foi possível corrigir o e-mail. Tente novamente. — código 1bkm1w6",
      ),
    );
    expect(console.error).toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Salvar" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
