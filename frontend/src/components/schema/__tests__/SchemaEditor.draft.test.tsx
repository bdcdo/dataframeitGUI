// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchemaEditorSession } from "../SchemaEditor";
import { schemaDraftStoragePrefix } from "@/hooks/useSchemaDraft";
import { schemaBaselineIdentity } from "@/lib/schema-utils";
import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: hoisted.refresh }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("sonner", () => ({ toast: hoisted.toast }));
vi.mock("../SchemaEditorHeader", () => ({
  SchemaEditorHeader: ({ currentVersion }: { currentVersion: string }) => (
    <div>Versão {currentVersion}</div>
  ),
}));
vi.mock("../SchemaEditorBanners", () => ({
  SchemaEditorBanners: ({
    draftConflict,
    onApplyDraft,
    onDiscardDraft,
  }: {
    draftConflict: unknown;
    onApplyDraft: () => void;
    onDiscardDraft: () => void;
  }) =>
    draftConflict ? (
      <div role="alert">
        Rascunho conflitante
        <button onClick={onApplyDraft}>Aplicar para revisar</button>
        <button onClick={onDiscardDraft}>Descartar</button>
      </div>
    ) : null,
}));
vi.mock("../SchemaEditorDialogs", () => ({ SchemaEditorDialogs: () => null }));
vi.mock("../SchemaBuilderGUI", () => ({
  SchemaBuilderGUI: ({
    fields,
    onChange,
  }: {
    fields: PydanticField[];
    onChange: (fields: PydanticField[]) => void;
  }) => (
    <div>
      <span>Campo: {fields[0]?.description}</span>
      <button
        type="button"
        onClick={() => onChange([{ ...fields[0], description: "Editada" }])}
      >
        Editar campo
      </button>
    </div>
  ),
}));

const BASE_FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "Original" },
];
const SAVED_FIELDS: PydanticField[] = [
  { ...BASE_FIELDS[0], description: "Editada", hash: "abc" },
];

beforeEach(() => {
  window.localStorage.clear();
  hoisted.saveSchemaFromGUI.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderEditor(fields = BASE_FIELDS, version = "0.1.0") {
  const view = render(
    <SchemaEditorSession
      projectId="project-1"
      initialCode={null}
      initialFields={fields}
      currentVersion={version}
    />,
  );
  await screen.findByRole("button", { name: "Editar campo" });
  return view;
}

function hasStoredDraft(projectId = "project-1") {
  const prefix = schemaDraftStoragePrefix(projectId);
  return Object.keys(window.localStorage).some((key) => key.startsWith(prefix));
}

function mockSavedSchema(error?: string) {
  hoisted.saveSchemaFromGUI.mockResolvedValue({
    saved: {
      fields: SAVED_FIELDS,
      ...schemaBaselineIdentity(SAVED_FIELDS, "0.1.1"),
    },
    ...(error ? { error } : {}),
  });
}

function mockRemoteConflict() {
  const remoteFields = [{ ...BASE_FIELDS[0], description: "Remota" }];
  hoisted.saveSchemaFromGUI.mockResolvedValue({
    conflict: {
      fields: remoteFields,
      ...schemaBaselineIdentity(remoteFields, "0.2.0"),
    },
    error: "Conflito remoto",
  });
  return remoteFields;
}

async function editAndSave() {
  await userEvent.click(screen.getByRole("button", { name: "Editar campo" }));
  await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
}

function makeStorageUnavailable() {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
}

describe("SchemaEditor — ciclo do draft", () => {
  it("save falho mantém o draft e o estado textual de não salvo", async () => {
    hoisted.saveSchemaFromGUI.mockResolvedValue({ error: "Falha remota" });
    await renderEditor();

    await userEvent.click(screen.getByRole("button", { name: "Editar campo" }));
    expect(screen.getByRole("status").textContent?.toLowerCase()).toContain(
      "alterações não salvas",
    );

    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha remota"));
    expect(hasStoredDraft()).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Alterações não salvas");
  });

  it("save confirmado limpa o draft, atualiza baseline/versão e remove o aviso", async () => {
    mockSavedSchema();
    await renderEditor();
    await editAndSave();

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Schema salvo!"));
    expect(hoisted.saveSchemaFromGUI).toHaveBeenCalledWith(
      "project-1",
      [{ ...BASE_FIELDS[0], description: "Editada" }],
      schemaBaselineIdentity(BASE_FIELDS, "0.1.0"),
    );
    expect(hasStoredDraft()).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Versão 0.1.1")).toBeTruthy();
  });

  it("save parcial reconhece baseline persistido e ainda mostra erro de auditoria", async () => {
    mockSavedSchema("Schema salvo, mas falha no histórico");
    await renderEditor();
    await editAndSave();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Schema salvo, mas falha no histórico",
      ),
    );
    expect(hasStoredDraft()).toBe(false);
    expect(screen.getByText("Versão 0.1.1")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("conflito remoto preserva o draft e exige aplicação explícita", async () => {
    mockRemoteConflict();
    await renderEditor();
    await editAndSave();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Rascunho conflitante",
    );
    expect(screen.getByText("Campo: Remota")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Rascunho conflitante",
    );
    expect(
      (screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Aplicar para revisar" }));
    expect(screen.getByText("Campo: Editada")).toBeTruthy();
    expect(screen.getByRole("status").textContent?.toLowerCase()).toContain(
      "alterações não salvas",
    );
  });

  it("conflito não persistido avisa no footer e mantém beforeunload", async () => {
    makeStorageUnavailable();
    mockRemoteConflict();
    await renderEditor();
    await editAndSave();
    await screen.findByRole("alert");

    expect(screen.getByRole("status").textContent).toContain(
      "Rascunho conflitante não gravado localmente",
    );
    expect(
      (screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    {
      label: "projeto",
      projectId: "project-2",
      fields: BASE_FIELDS,
      version: "0.1.0",
      expectedDescription: "Original",
      expectConflict: false,
    },
    {
      label: "versão",
      projectId: "project-1",
      fields: BASE_FIELDS,
      version: "0.2.0",
      expectedDescription: "Original",
      expectConflict: true,
    },
    {
      label: "fingerprint remoto",
      projectId: "project-1",
      fields: [{ ...BASE_FIELDS[0], description: "Remota" }],
      version: "0.1.0",
      expectedDescription: "Remota",
      expectConflict: true,
    },
  ])("boundary de sessão remonta o editor ao trocar $label", async (next) => {
    const view = await renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Editar campo" }));
    expect(screen.getByText("Campo: Editada")).toBeTruthy();

    view.rerender(
      <SchemaEditorSession
        projectId={next.projectId}
        initialCode={null}
        initialFields={next.fields}
        currentVersion={next.version}
      />,
    );

    expect(
      await screen.findByText(`Campo: ${next.expectedDescription}`),
    ).toBeTruthy();
    expect(screen.getByText(`Versão ${next.version}`)).toBeTruthy();
    if (next.expectConflict) {
      expect(screen.getByRole("status").textContent).toContain(
        "Rascunho conflitante",
      );
    } else {
      expect(screen.queryByRole("status")).toBeNull();
    }
  });

  it("storage indisponível informa o limite para navegação interna", async () => {
    makeStorageUnavailable();
    await renderEditor();

    await userEvent.click(screen.getByRole("button", { name: "Editar campo" }));

    expect(screen.getByRole("status").textContent).toContain(
      "a navegação interna pode perdê-las",
    );
  });
});
