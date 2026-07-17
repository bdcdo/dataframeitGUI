// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  unifyMembers: vi.fn(),
}));

vi.mock("@/actions/members", () => ({
  unifyMembers: mocks.unifyMembers,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { UnifyMembersDialog } from "@/components/members/UnifyMembersDialog";
import type { UnificationPreview } from "@/actions/members";

const basePreview: UnificationPreview = {
  sourceUserId: "source-1",
  sourceName: "Bruno",
  targetUserId: "target-1",
  assignmentsToMigrate: 2,
  docsWithBothResponses: 1,
  reviewConflicts: 0,
  arbitrationConflicts: 0,
  comparisonConflicts: 0,
  resultingRole: "pesquisador",
  linkEmail: "owner@example.com",
};

function renderDialog(
  preview: UnificationPreview = basePreview,
  onClose = vi.fn(),
) {
  render(
    <UnifyMembersDialog
      projectId="project-1"
      preview={preview}
      targetName="Ana"
      onClose={onClose}
    />,
  );
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("UnifyMembersDialog", () => {
  it("envia o e-mail confirmado pelo preview para a unificação", async () => {
    mocks.unifyMembers.mockResolvedValue({});
    const user = userEvent.setup();
    const onClose = renderDialog();

    await user.click(
      screen.getByRole("button", { name: "Unificar membros" }),
    );

    await waitFor(() =>
      expect(mocks.unifyMembers).toHaveBeenCalledWith(
        "project-1",
        "source-1",
        "target-1",
        "owner@example.com",
      ),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("libera o botão e informa erro quando a action rejeita", async () => {
    mocks.unifyMembers.mockRejectedValue(new Error("network failure"));
    const user = userEvent.setup();
    renderDialog();

    await user.click(
      screen.getByRole("button", { name: "Unificar membros" }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Não foi possível unificar os membros. Tente novamente.",
      ),
    );
    const button = screen.getByRole("button", {
      name: "Unificar membros",
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    "reviewConflicts" as const,
    "arbitrationConflicts" as const,
    "comparisonConflicts" as const,
  ])("%s maior que zero bloqueia a unificação", async (field) => {
    const user = userEvent.setup();
    renderDialog({ ...basePreview, [field]: 1 });

    expect(
      screen.getByText(/A unificação está bloqueada/),
    ).toBeTruthy();
    const button = screen.getByRole("button", {
      name: "Unificar membros",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await user.click(button);
    expect(mocks.unifyMembers).not.toHaveBeenCalled();
  });
});
