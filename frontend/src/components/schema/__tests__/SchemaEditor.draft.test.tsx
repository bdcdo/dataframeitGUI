// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchemaEditorSession } from "../SchemaEditor";
import { schemaDraftStorageKey } from "@/hooks/useSchemaDraft";
import type { PydanticField } from "@/lib/types";
import type { SchemaDraftConflict } from "@/hooks/useSchemaDraft";
import {
  unresolvedSchemaConflicts,
  type SchemaMergeChoice,
} from "@/lib/schema-merge";

const hoisted = vi.hoisted(() => ({
  saveSchemaFromGUI: vi.fn(),
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
  publishMajorVersion: vi.fn(),
  backfillSchemaVersionHistory: vi.fn(),
  recoverFieldsFromStoredCode: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: hoisted.refresh }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("sonner", () => ({ toast: hoisted.toast }));
vi.mock("../SchemaEditorHeader", () => ({
  SchemaEditorHeader: ({ currentVersion }: { currentVersion: string }) => (
    <div>Versão {currentVersion}</div>
  ),
}));
vi.mock("../SchemaEditorBanners", () => ({
  SchemaEditorBanners: ({ draftConflict }: { draftConflict: unknown }) =>
    draftConflict ? <div role="alert">Rascunho conflitante</div> : null,
}));
vi.mock("../SchemaEditorDialogs", () => ({
  SchemaEditorDialogs: ({
    conflict,
    onResolveConflict,
    onApplyResolvedDraft,
  }: {
    conflict: SchemaDraftConflict | null;
    onResolveConflict: (id: string, choice: SchemaMergeChoice) => void;
    onApplyResolvedDraft: () => boolean;
  }) =>
    conflict ? (
      <dialog open aria-label="Resolver alterações concorrentes">
        <button
          onClick={() => onResolveConflict(conflict.merge.conflicts[0].id, "local")}
        >
          Minha alteração
        </button>
        <button
          disabled={unresolvedSchemaConflicts(conflict.merge).length > 0}
          onClick={onApplyResolvedDraft}
        >
          Aplicar merge para revisar
        </button>
      </dialog>
    ) : null,
}));
vi.mock("../SchemaBuilderGUI", () => ({
  SchemaBuilderGUI: ({ fields, onChange }: {
    fields: PydanticField[];
    onChange: (fields: PydanticField[]) => void;
  }) => (
    <div>
      <span>Campo: {fields[0]?.description}</span>
      <button onClick={() => onChange([{ ...fields[0], description: "Editada" }])}>
        Editar campo
      </button>
    </div>
  ),
}));

const BASE_FIELDS: PydanticField[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "q1",
    type: "text",
    options: null,
    description: "Original",
  },
];
const SAVED_FIELDS = [{ ...BASE_FIELDS[0], description: "Editada", hash: "abc" }];

beforeEach(() => {
  window.localStorage.clear();
  hoisted.saveSchemaFromGUI.mockReset();
  Object.values(hoisted.toast).forEach((mock) => mock.mockClear());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SCOPE = { projectId: "project-1", userId: "user-1" };

async function renderEditor(fields = BASE_FIELDS, version = "0.1.0", revision = 0) {
  const view = render(
    <SchemaEditorSession
      projectId="project-1"
      userId="user-1"
      initialCode={null}
      initialFields={fields}
      currentVersion={version}
      currentRevision={revision}
    />,
  );
  await screen.findByRole("button", { name: "Editar campo" });
  return view;
}

async function editAndSave() {
  await userEvent.click(screen.getByRole("button", { name: "Editar campo" }));
  await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
}

describe("SchemaEditor — ciclo do draft", () => {
  it("erro transacional preserva o rascunho e o estado não salvo", async () => {
    hoisted.saveSchemaFromGUI.mockResolvedValue({ status: "error", message: "Falha remota" });
    await renderEditor();
    await editAndSave();

    await waitFor(() => expect(hoisted.toast.error).toHaveBeenCalledWith("Falha remota"));
    expect(window.localStorage.getItem(schemaDraftStorageKey(SCOPE))).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Alterações não salvas");
  });

  it("save confirmado limpa o draft e adota revisão e versão canônicas", async () => {
    hoisted.saveSchemaFromGUI.mockResolvedValue({
      status: "saved",
      snapshot: { fields: SAVED_FIELDS, version: "0.1.1", revision: 1 },
    });
    await renderEditor();
    await editAndSave();

    await waitFor(() => expect(hoisted.toast.success).toHaveBeenCalledWith("Schema salvo!"));
    expect(hoisted.saveSchemaFromGUI).toHaveBeenCalledWith(
      "project-1",
      [{ ...BASE_FIELDS[0], description: "Editada" }],
      { revision: 0 },
    );
    expect(window.localStorage.getItem(schemaDraftStorageKey(SCOPE))).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Versão 0.1.1")).toBeTruthy();
  });

  it("bloqueia o save até escolher e aplicar o merge de três vias", async () => {
    const remoteFields = [{ ...BASE_FIELDS[0], description: "Remota" }];
    hoisted.saveSchemaFromGUI.mockResolvedValue({
      status: "conflict",
      current: { fields: remoteFields, version: "0.2.0", revision: 2 },
    });
    await renderEditor();
    await editAndSave();

    expect(await screen.findByRole("dialog", { name: "Resolver alterações concorrentes" })).toBeTruthy();
    expect(screen.getByText("Campo: Remota")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Minha alteração" }));
    await userEvent.click(screen.getByRole("button", { name: "Aplicar merge para revisar" }));

    expect(screen.getByText("Campo: Editada")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("uma revisão nova passa pelo merge sem descartar a edição em memória", async () => {
    const view = await renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Editar campo" }));

    view.rerender(
      <SchemaEditorSession
        projectId="project-1"
        userId="user-1"
        initialCode={null}
        initialFields={[{ ...BASE_FIELDS[0], description: "Remota" }]}
        currentVersion="0.2.0"
        currentRevision={1}
      />,
    );

    expect(await screen.findByRole("dialog", { name: "Resolver alterações concorrentes" })).toBeTruthy();
    expect(screen.getByText("Campo: Remota")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Minha alteração" })).toBeTruthy();
    expect(screen.getByText("Versão 0.2.0")).toBeTruthy();
  });

  // `origin` fica em "rebased" após o primeiro merge automático; o segundo
  // rebase consecutivo substituía os campos no canvas sem anúncio (#501).
  it("anuncia cada rebase automático, inclusive consecutivos", async () => {
    const view = await renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Editar campo" }));

    const remoteRevision = (help_text: string, revision: number) =>
      view.rerender(
        <SchemaEditorSession
          projectId="project-1"
          userId="user-1"
          initialCode={null}
          initialFields={[{ ...BASE_FIELDS[0], help_text }]}
          currentVersion={`0.1.${revision}`}
          currentRevision={revision}
        />,
      );

    remoteRevision("Ajuda remota", 1);
    await waitFor(() =>
      expect(hoisted.toast.info).toHaveBeenCalledTimes(1),
    );

    remoteRevision("Ajuda remota revista", 2);
    await waitFor(() =>
      expect(hoisted.toast.info).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByText("Campo: Editada")).toBeTruthy();
  });

  // Um rebase anunciado é um rebase FECHADO. `stateAfterRemoteChange` preserva a
  // proveniência no ramo de conflito (de propósito: quem decide é o usuário no
  // diálogo), e a baseline de um estado em conflito já é o remoto novo — então a
  // revisão sozinha anuncia "suas alterações foram mescladas" exatamente
  // enquanto o diálogo pede que as colisões sejam resolvidas.
  it("não anuncia rebase quando a revisão nova abre conflito", async () => {
    const view = await renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Editar campo" }));

    const remoteRevision = (field: PydanticField, revision: number) =>
      view.rerender(
        <SchemaEditorSession
          projectId="project-1"
          userId="user-1"
          initialCode={null}
          initialFields={[field]}
          currentVersion={`0.1.${revision}`}
          currentRevision={revision}
        />,
      );

    // Primeiro rebase fecha limpo (o remoto tocou outra propriedade).
    remoteRevision({ ...BASE_FIELDS[0], help_text: "Ajuda remota" }, 1);
    await waitFor(() => expect(hoisted.toast.info).toHaveBeenCalledTimes(1));

    // O segundo colide na propriedade que o usuário editou.
    remoteRevision(
      { ...BASE_FIELDS[0], help_text: "Ajuda remota", description: "Remota" },
      2,
    );
    expect(
      await screen.findByRole("dialog", { name: "Resolver alterações concorrentes" }),
    ).toBeTruthy();
    expect(hoisted.toast.info).toHaveBeenCalledTimes(1);

    // Fechar o merge pela resolução manual é o rebase que faltava anunciar: a
    // revisão não muda (a baseline já era o remoto), só o conflito é que zera.
    await userEvent.click(screen.getByRole("button", { name: "Minha alteração" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Aplicar merge para revisar" }),
    );
    await waitFor(() => expect(hoisted.toast.info).toHaveBeenCalledTimes(2));
  });
});

// O segmento /config não tem `error.tsx`, então lançar aqui trocava uma condição
// diagnosticável pela tela genérica de erro do Next. O servidor trata a mesma
// condição devolvendo copy em `loadSchemaSaveContext`; a UI acompanha.
describe("SchemaEditorSession — schema persistido inválido", () => {
  const invalido = [
    { ...BASE_FIELDS[0], propriedadeDesconhecida: "veio do banco" },
  ] as unknown as PydanticField[];

  it("informa em vez de derrubar a página", () => {
    expect(() =>
      render(
        <SchemaEditorSession
          projectId="project-1"
          userId="user-1"
          initialCode={null}
          initialFields={invalido}
          currentVersion="0.1.0"
          currentRevision={0}
        />,
      ),
    ).not.toThrow();

    expect(screen.getByText(/schema gravado deste projeto está inválido/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
  });

  it("um schema válido segue montando o editor", () => {
    render(
      <SchemaEditorSession
        projectId="project-1"
        userId="user-1"
        initialCode={null}
        initialFields={BASE_FIELDS}
        currentVersion="0.1.0"
        currentRevision={0}
      />,
    );
    expect(screen.queryByText(/schema gravado deste projeto está inválido/i)).toBeNull();
  });
});
