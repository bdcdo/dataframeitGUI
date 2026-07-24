// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditFieldDialog } from "../EditFieldDialog";
import type { PydanticField } from "@/lib/types";

const hoisted = vi.hoisted(() => ({
  saveSchemaFromGUI: vi.fn(),
  approveSchemaSuggestionWithEdits: vi.fn(),
  refresh: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/actions/schema", () => ({
  saveSchemaFromGUI: hoisted.saveSchemaFromGUI,
}));
vi.mock("@/actions/suggestions", () => ({
  approveSchemaSuggestionWithEdits: hoisted.approveSchemaSuggestionWithEdits,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: hoisted.refresh }),
}));
vi.mock("sonner", () => ({ toast: hoisted.toast }));

const fieldA: PydanticField = {
  name: "a",
  type: "text",
  options: null,
  description: "Descrição base",
  help_text: "Ajuda base",
};

beforeEach(() => {
  hoisted.saveSchemaFromGUI.mockReset();
  hoisted.approveSchemaSuggestionWithEdits.mockReset();
  Object.values(hoisted.toast).forEach((mock) => mock.mockClear());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function dialogAt(fields: PydanticField[], revision: number) {
  return (
    <EditFieldDialog
      projectId="project-1"
      fieldName="a"
      allFields={fields}
      open
      onOpenChange={vi.fn()}
      schemaBaseline={{ revision }}
    />
  );
}

function descriptionInput(): HTMLInputElement {
  return screen.getByPlaceholderText(
    "O que este campo representa?",
  ) as HTMLInputElement;
}

async function typeDescription(text: string) {
  const input = descriptionInput();
  await userEvent.clear(input);
  await userEvent.type(input, text);
}

function savedFieldsArg(call = 0): PydanticField[] {
  return hoisted.saveSchemaFromGUI.mock.calls[call][1] as PydanticField[];
}

// O formulário congela na abertura (por design: um refresh RSC não pode apagar
// a digitação), mas o save e a exibição precisam reconciliar com o remoto que
// avançou sob o diálogo aberto — issue #501.
describe("EditFieldDialog — remoto avança com o diálogo aberto", () => {
  it("salvar não reverte edição concorrente de outra propriedade", async () => {
    hoisted.saveSchemaFromGUI.mockResolvedValue({
      status: "saved",
      snapshot: { fields: [], version: "0.1.2", revision: 3 },
    });
    const view = render(dialogAt([fieldA], 1));
    await typeDescription("Descrição editada");

    // Refresh RSC aterrissa: outro coordenador mudou o help_text.
    view.rerender(dialogAt([{ ...fieldA, help_text: "Ajuda remota" }], 2));
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(hoisted.saveSchemaFromGUI).toHaveBeenCalled());
    expect(hoisted.saveSchemaFromGUI).toHaveBeenCalledWith(
      "project-1",
      expect.anything(),
      { revision: 2 },
    );
    expect(savedFieldsArg()[0]).toMatchObject({
      description: "Descrição editada",
      help_text: "Ajuda remota",
    });
    expect(hoisted.toast.error).not.toHaveBeenCalled();
  });

  it("o aviso de descrição compara com o base do form, não com o remoto vivo", async () => {
    const view = render(dialogAt([fieldA], 1));
    expect(screen.queryByText(/Alterar a descrição/)).toBeNull();

    view.rerender(dialogAt([{ ...fieldA, description: "Descrição remota" }], 2));

    // O input ainda mostra o valor com que o form foi semeado; o usuário não
    // alterou nada, então não há aviso a dar.
    expect(descriptionInput().value).toBe("Descrição base");
    expect(screen.queryByText(/Alterar a descrição/)).toBeNull();
  });

  it("baseline stale re-mescla e reenvia uma vez em vez de descartar a edição", async () => {
    hoisted.saveSchemaFromGUI
      .mockResolvedValueOnce({
        status: "conflict",
        current: {
          fields: [{ ...fieldA, help_text: "Ajuda remota" }],
          version: "0.1.4",
          revision: 5,
        },
      })
      .mockResolvedValueOnce({
        status: "saved",
        snapshot: { fields: [], version: "0.1.5", revision: 6 },
      });
    render(dialogAt([fieldA], 1));
    await typeDescription("Descrição editada");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(hoisted.saveSchemaFromGUI).toHaveBeenCalledTimes(2),
    );
    expect(hoisted.saveSchemaFromGUI).toHaveBeenLastCalledWith(
      "project-1",
      expect.anything(),
      { revision: 5 },
    );
    expect(savedFieldsArg(1)[0]).toMatchObject({
      description: "Descrição editada",
      help_text: "Ajuda remota",
    });
    expect(hoisted.toast.success).toHaveBeenCalled();
    expect(hoisted.toast.error).not.toHaveBeenCalled();
  });

  it("erro do save mantém o diálogo aberto com a digitação", async () => {
    hoisted.saveSchemaFromGUI.mockResolvedValue({
      status: "error",
      message: "Falha remota",
    });
    render(dialogAt([fieldA], 1));
    await typeDescription("Descrição editada");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(hoisted.toast.error).toHaveBeenCalledWith("Falha remota"),
    );
    expect(hoisted.toast.success).not.toHaveBeenCalled();
    expect(descriptionInput().value).toBe("Descrição editada");
  });

  it("colisão na mesma propriedade bloqueia o save sem perder a digitação", async () => {
    const view = render(dialogAt([fieldA], 1));
    await typeDescription("Descrição editada");

    view.rerender(
      dialogAt([{ ...fieldA, description: "Descrição remota" }], 2),
    );
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(hoisted.toast.error).toHaveBeenCalled());
    expect(hoisted.saveSchemaFromGUI).not.toHaveBeenCalled();
    // O diálogo permanece aberto com o trabalho do usuário intacto.
    expect(descriptionInput().value).toBe("Descrição editada");
  });
});

// A aprovação de sugestão é a via cujo contrato mais mudou: o conflito de CAS
// deixou de sair achatado em `error` e passou a voltar tipado, com o snapshot
// atual, para que o re-merge e o reenvio sejam possíveis (#501). Ela usa uma
// Server Action distinta, então precisa do seu próprio par de testes.
describe("EditFieldDialog — aprovação de sugestão", () => {
  const SUGGESTION = {
    id: "suggestion-1",
    changes: { description: "Descrição sugerida" },
  };

  function suggestionDialogAt(fields: PydanticField[], revision: number) {
    return (
      <EditFieldDialog
        projectId="project-1"
        fieldName="a"
        allFields={fields}
        open
        onOpenChange={vi.fn()}
        schemaBaseline={{ revision }}
        pendingSuggestion={SUGGESTION}
      />
    );
  }

  it("baseline stale re-mescla sobre o snapshot devolvido e reenvia uma vez", async () => {
    hoisted.approveSchemaSuggestionWithEdits
      .mockResolvedValueOnce({
        conflict: {
          fields: [{ ...fieldA, help_text: "Ajuda remota" }],
          version: "0.1.4",
          revision: 5,
        },
      })
      .mockResolvedValueOnce({});
    render(suggestionDialogAt([fieldA], 1));

    // O form já vem semeado com a proposta; aprovar é salvar o que ela pede.
    expect(descriptionInput().value).toBe("Descrição sugerida");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(hoisted.approveSchemaSuggestionWithEdits).toHaveBeenCalledTimes(2),
    );
    const [suggestionId, projectId, fields, baseline] =
      hoisted.approveSchemaSuggestionWithEdits.mock.calls[1];
    expect([suggestionId, projectId, baseline]).toEqual([
      "suggestion-1",
      "project-1",
      { revision: 5 },
    ]);
    expect((fields as PydanticField[])[0]).toMatchObject({
      description: "Descrição sugerida",
      help_text: "Ajuda remota",
    });
    expect(hoisted.toast.success).toHaveBeenCalledWith(
      "Sugestão aprovada e campo atualizado",
    );
  });

  it("erro da action não é confundido com aprovação", async () => {
    hoisted.approveSchemaSuggestionWithEdits.mockResolvedValue({
      error: "Sugestão já resolvida por outro coordenador.",
    });
    render(suggestionDialogAt([fieldA], 1));
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(hoisted.toast.error).toHaveBeenCalledWith(
        "Sugestão já resolvida por outro coordenador.",
      ),
    );
    expect(hoisted.toast.success).not.toHaveBeenCalled();
  });
});
