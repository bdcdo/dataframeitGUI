// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MemberRow } from "../member-list-utils";

const mocks = vi.hoisted(() => ({
  removeMember: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/actions/members", () => ({
  removeMember: mocks.removeMember,
  changeRole: vi.fn(),
  setCanArbitrate: vi.fn(),
  setCanResolve: vi.fn(),
  setCanCompare: vi.fn(),
  unlinkMemberEmail: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { MemberList } from "../MemberList";

const targetMember: MemberRow = {
  id: "member-target",
  project_id: "project-1",
  user_id: "user-target",
  role: "pesquisador",
  can_arbitrate: false,
  can_resolve: false,
  can_compare: false,
  profiles: {
    id: "user-target",
    email: "ana@example.com",
    first_name: "Ana",
    last_name: "Silva",
    created_at: "2026-01-01T00:00:00Z",
    activated_at: "2026-01-02T00:00:00Z",
  },
};

function renderList({
  member = targetMember,
  effectiveUserId = "coordinator-user",
}: {
  member?: MemberRow;
  effectiveUserId?: string;
} = {}) {
  return render(
    <MemberList
      projectId="project-1"
      members={[member]}
      emailLinks={[]}
      effectiveUserId={effectiveUserId}
    />,
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.removeMember.mockResolvedValue(undefined);
});

describe("MemberList — confirmação de remoção", () => {
  it("abre um alertdialog identificado e não chama a action no clique inicial", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Remover" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.textContent).toContain("Ana");
    expect(dialog.textContent).toContain("ana@example.com");
    expect(screen.getByRole("button", { name: "Cancelar" })).toBe(document.activeElement);
    expect(mocks.removeMember).not.toHaveBeenCalled();
  });

  it("cancela sem remover o membro", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Remover" }));
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.removeMember).not.toHaveBeenCalled();
  });

  it("confirma uma única vez com o membro e bloqueia cliques concorrentes", async () => {
    let finishRemoval: ((value: undefined) => void) | undefined;
    mocks.removeMember.mockReturnValue(
      new Promise<undefined>((resolve) => {
        finishRemoval = resolve;
      }),
    );
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Remover" }));
    const confirm = await screen.findByRole("button", { name: "Remover" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(mocks.removeMember).toHaveBeenCalledTimes(1);
    expect(mocks.removeMember).toHaveBeenCalledWith("member-target");
    expect(screen.getByRole("button", { name: "Removendo…" }).hasAttribute("disabled")).toBe(true);

    finishRemoval?.(undefined);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Membro removido");
  });

  it("mantém o diálogo aberto após erro e permite tentar novamente sem falso sucesso", async () => {
    mocks.removeMember
      .mockResolvedValueOnce({ error: "Falha ao remover" })
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Remover" }));
    await user.click(await screen.findByRole("button", { name: "Remover" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Falha ao remover"));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remover" }));

    await waitFor(() => expect(mocks.removeMember).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("mantém o diálogo aberto quando a action lança e permite tentar novamente", async () => {
    mocks.removeMember
      .mockRejectedValueOnce(new Error("rede indisponível"))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Remover" }));
    await user.click(await screen.findByRole("button", { name: "Remover" }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Não foi possível remover o membro. Tente novamente.",
      ),
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remover" }));

    await waitFor(() => expect(mocks.removeMember).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("não oferece remoção para a identidade canônica exercida pela conta atual", () => {
    renderList({ effectiveUserId: targetMember.user_id });

    expect(screen.queryByRole("button", { name: "Remover" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
