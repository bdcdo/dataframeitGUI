// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstructionChangeDialog } from "../InstructionChangeDialog";
import { useInstructionChangeGuard } from "../useInstructionChangeGuard";
import { applyInstructionChoices } from "@/lib/question-revision";
import type { PydanticField } from "@/lib/types";

const saved: PydanticField[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "resultado",
    type: "single",
    options: ["Sim", "Não"],
    description: "Houve provimento?",
    help_text: "Antes",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "nota",
    type: "text",
    options: null,
    description: "Observações",
    question_revision: 1,
  },
];

// O mesmo encadeamento das duas entradas de save: pergunta, e aplica as
// escolhas ao rascunho.
function Harness({
  draft,
  onResult,
}: {
  draft: PydanticField[];
  onResult: (fields: PydanticField[] | null) => void;
}) {
  const { confirmInstructionChanges, dialogProps } = useInstructionChangeGuard();
  const save = async () => {
    const choices = await confirmInstructionChanges(saved, draft);
    onResult(choices ? applyInstructionChoices(saved, draft, choices) : null);
  };
  return (
    <>
      <button type="button" onClick={() => void save()}>
        Salvar schema
      </button>
      {dialogProps && <InstructionChangeDialog open {...dialogProps} />}
    </>
  );
}

const bothChanged = saved.map((field) => ({ ...field, help_text: "Depois" }));

function renderHarness(draft: PydanticField[]) {
  const onResult = vi.fn();
  render(<Harness draft={draft} onResult={onResult} />);
  return { onResult, user: userEvent.setup() };
}

const fieldGroup = (name: string) => screen.getByRole("group", { name: new RegExp(name) });
const pressed = (field: string, choice: string) =>
  within(fieldGroup(field)).getByRole("button", { name: choice }).getAttribute("aria-pressed");

afterEach(cleanup);

describe("InstructionChangeDialog", () => {
  it("não abre quando nenhuma instrução mudou", async () => {
    const draft = saved.map((field) => ({ ...field }));
    const { onResult, user } = renderHarness(draft);
    await user.click(screen.getByRole("button", { name: "Salvar schema" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onResult).toHaveBeenCalledWith(draft);
  });

  it("nasce sem escolha e só confirma com todos os campos escolhidos", async () => {
    const { onResult, user } = renderHarness(bothChanged);
    await user.click(screen.getByRole("button", { name: "Salvar schema" }));

    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Salvar" });
    // Dois botões por campo, nenhum pré-selecionado.
    expect(within(dialog).getAllByRole("button", { pressed: false })).toHaveLength(4);
    expect(within(dialog).queryAllByRole("button", { pressed: true })).toEqual([]);
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(dialog.textContent).toContain("Falta a escolha de 2 campos");

    await user.click(within(fieldGroup("resultado")).getByRole("button", { name: "Muda como responder" }));
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(dialog.textContent).toContain("Falta a escolha de 1 campo");
    await user.click(confirm);
    expect(onResult).not.toHaveBeenCalled();

    await user.click(within(fieldGroup("nota")).getByRole("button", { name: "Só esclarece" }));
    expect(confirm.hasAttribute("disabled")).toBe(false);
    expect(pressed("resultado", "Muda como responder")).toBe("true");
    expect(pressed("resultado", "Só esclarece")).toBe("false");

    await user.click(confirm);
    const [fields] = onResult.mock.calls[0] as [PydanticField[]];
    // "Muda como responder" sobe o contador; "Só esclarece" deixa como estava.
    expect(fields[0].question_revision).toBe(1);
    expect(fields[1].question_revision).toBe(1);
    expect(fields[1]).toBe(bothChanged[1]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("trocar a escolha vale a última", async () => {
    const { onResult, user } = renderHarness(bothChanged);
    await user.click(screen.getByRole("button", { name: "Salvar schema" }));
    await user.click(within(fieldGroup("nota")).getByRole("button", { name: "Só esclarece" }));
    await user.click(within(fieldGroup("nota")).getByRole("button", { name: "Muda como responder" }));
    await user.click(within(fieldGroup("resultado")).getByRole("button", { name: "Só esclarece" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    const [fields] = onResult.mock.calls[0] as [PydanticField[]];
    expect(fields[0].question_revision).toBeUndefined();
    expect(fields[1].question_revision).toBe(2);
  });

  it("cancelar desiste do save", async () => {
    const { onResult, user } = renderHarness(bothChanged);
    await user.click(screen.getByRole("button", { name: "Salvar schema" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onResult).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
