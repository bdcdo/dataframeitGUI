// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  linkMemberEmail: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/actions/members", () => ({
  linkMemberEmail: mocks.linkMemberEmail,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { LinkEmailDialog } from "@/components/members/LinkEmailDialog";

const linkedResult = (access: "ready" | "pending") => ({
  status: "linked" as const,
  access,
  link: {
    id: "link-1",
    project_id: "project-1",
    member_user_id: "member-1",
    email: "alias@example.com",
    linked_user_id: access === "ready" ? "owner-1" : null,
    created_by: "coordinator-1",
    created_at: "2026-07-15T12:00:00Z",
  },
});

function renderDialog() {
  const onOpenChange = vi.fn();
  const onRequiresUnification = vi.fn();
  render(
    <LinkEmailDialog
      projectId="project-1"
      memberUserId="member-1"
      memberName="Ana"
      open
      onOpenChange={onOpenChange}
      onRequiresUnification={onRequiresUnification}
    />,
  );
  return { onOpenChange, onRequiresUnification };
}

async function submitAliasEmail() {
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("E-mail adicional"),
    "alias@example.com",
  );
  await user.click(screen.getByRole("button", { name: "Vincular" }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("LinkEmailDialog", () => {
  it("associa um label acessível ao campo de e-mail", () => {
    renderDialog();

    const input = screen.getByLabelText("E-mail adicional");
    expect(input.getAttribute("type")).toBe("email");
    expect(input.getAttribute("id")).toBe("linked-member-email");
  });

  it.each([
    [
      "ready" as const,
      "E-mail vinculado. A conta passa a acessar o projeto como este membro.",
    ],
    [
      "pending" as const,
      "E-mail vinculado. Quando a conta for criada com este e-mail, ela entrará no projeto como este membro.",
    ],
  ])("usa o toast correspondente a access=%s", async (access, message) => {
    mocks.linkMemberEmail.mockResolvedValue(linkedResult(access));
    const { onOpenChange } = renderDialog();

    await submitAliasEmail();

    await waitFor(() =>
      expect(mocks.linkMemberEmail).toHaveBeenCalledWith(
        "project-1",
        "member-1",
        "alias@example.com",
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(message);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("libera o botão e informa erro quando a action rejeita", async () => {
    mocks.linkMemberEmail.mockRejectedValue(new Error("network failure"));
    renderDialog();

    await submitAliasEmail();

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Não foi possível vincular o e-mail. Tente novamente.",
      ),
    );
    const button = screen.getByRole("button", { name: "Vincular" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
