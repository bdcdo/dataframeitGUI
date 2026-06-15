// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createProjectComment = vi.fn();

vi.mock("@/actions/project-comments", () => ({
  createProjectComment: (...args: unknown[]) => createProjectComment(...args),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AddNoteButton } from "@/components/shared/AddNoteButton";

afterEach(cleanup);
beforeEach(() => {
  createProjectComment.mockReset();
  createProjectComment.mockResolvedValue({ error: null });
});

describe("AddNoteButton — fixed field", () => {
  it("shows the human-readable field label in the dialog context, not the machine name", async () => {
    const user = userEvent.setup();
    render(
      <AddNoteButton
        projectId="p1"
        documentId="d1"
        documentTitle="Documento X"
        fieldName="tipo_decisao"
        fieldLabel="Tipo de decisão"
      />,
    );

    await user.click(screen.getByRole("button", { name: /nota/i }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("Documento X → Tipo de decisão")).toBeTruthy();
    expect(within(dialog).queryByText("tipo_decisao")).toBeNull();
  });

  it("hides the field select and submits the comment bound to the fixed field", async () => {
    const user = userEvent.setup();
    render(
      <AddNoteButton
        projectId="p1"
        documentId="d1"
        documentTitle="Documento X"
        fieldName="tipo_decisao"
        fieldLabel="Tipo de decisão"
        fields={[{ name: "tipo_decisao", type: "text", options: null, description: "Tipo de decisão" }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /nota/i }));
    const dialog = screen.getByRole("dialog");

    // fieldName fixo => sem select de campo
    expect(within(dialog).queryByRole("combobox")).toBeNull();

    await user.type(within(dialog).getByRole("textbox"), "minha nota");
    await user.click(within(dialog).getByRole("button", { name: /salvar nota/i }));

    await vi.waitFor(() =>
      expect(createProjectComment).toHaveBeenCalledWith(
        "p1",
        "minha nota",
        "d1",
        "tipo_decisao",
      ),
    );
  });
});
