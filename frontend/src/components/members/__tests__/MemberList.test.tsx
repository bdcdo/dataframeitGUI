// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MemberRow } from "../member-list-utils";

const mocks = vi.hoisted(() => ({
  removeMember: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

// O módulo importa seis actions; declarar só a testada quebraria o import.
vi.mock("@/actions/members", () => ({
  removeMember: mocks.removeMember,
  changeRole: vi.fn(),
  setCanArbitrate: vi.fn(),
  setCanResolve: vi.fn(),
  setCanCompare: vi.fn(),
  unlinkMemberEmail: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
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
  accessState: "ready",
  isClaimable: false,
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
  currentUserId = "coordinator-user",
}: { member?: MemberRow; currentUserId?: string } = {}) {
  return render(
    <MemberList
      projectId="project-1"
      members={[member]}
      emailLinks={[]}
      currentUserId={currentUserId}
    />,
  );
}

// O gatilho e o botão de confirmação compartilham o rótulo "Remover"; dentro do
// diálogo a busca é escopada para não casar com o gatilho que segue montado.
function confirmButton() {
  return within(screen.getByRole("alertdialog")).getByRole("button", {
    name: "Remover",
  });
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.removeMember.mockResolvedValue(undefined);
});

describe("MemberList — confirmação de remoção (#177)", () => {
  it("abre um alertdialog identificado e não chama a action no clique inicial", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Remover" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.textContent).toContain("Ana");
    expect(dialog.textContent).toContain("ana@example.com");
    expect(screen.getByRole("button", { name: "Cancelar" })).toBe(
      document.activeElement,
    );
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

  it("confirma uma única vez com o membro e sinaliza o progresso", async () => {
    let finishRemoval: ((value: undefined) => void) | undefined;
    mocks.removeMember.mockReturnValue(
      new Promise<undefined>((resolve) => {
        finishRemoval = resolve;
      }),
    );
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Remover" }));
    await user.click(confirmButton());

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Removendo…" }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(mocks.removeMember).toHaveBeenCalledTimes(1);
    expect(mocks.removeMember).toHaveBeenCalledWith("member-target");

    finishRemoval?.(undefined);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Membro removido");
  });

  it("mantém o diálogo aberto após erro e permite tentar novamente", async () => {
    mocks.removeMember
      .mockResolvedValueOnce({ error: "Falha ao remover" })
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Remover" }));
    await user.click(confirmButton());

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Falha ao remover"),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    await user.click(confirmButton());

    await waitFor(() => expect(mocks.removeMember).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("mantém o diálogo aberto quando a action rejeita e permite tentar novamente", async () => {
    mocks.removeMember
      .mockRejectedValueOnce(new Error("rede indisponível"))
      .mockResolvedValueOnce(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "Remover" }));
    await user.click(confirmButton());

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Não foi possível remover o membro. Tente novamente.",
      ),
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    await user.click(confirmButton());

    await waitFor(() => expect(mocks.removeMember).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("não oferece remoção para a identidade canônica exercida pela conta atual", () => {
    renderList({ currentUserId: targetMember.user_id });

    expect(screen.queryByRole("button", { name: "Remover" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("nomeia o membro sem perfil pelo fallback, sem quebrar a descrição", async () => {
    const user = userEvent.setup();
    renderList({ member: { ...targetMember, profiles: null } });

    await user.click(screen.getByRole("button", { name: "Remover" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Sem perfil");
  });
});
