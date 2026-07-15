// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_DRAFT_FORMAT_VERSION } from "@/lib/schema-draft";
import { SchemaEditorBanners } from "../SchemaEditorBanners";
import type { SchemaDraftConflict } from "@/hooks/useSchemaDraft";

const conflict: SchemaDraftConflict = {
  currentVersion: "0.2.0",
  draft: {
    formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
    draftId: "draft-1",
    revision: 1,
    updatedAt: 1,
    baseVersion: "0.2.0",
    baseFingerprint: "fingerprint-antigo",
    fields: [
      {
        name: "q1",
        type: "text",
        options: null,
        description: "Edição local",
      },
    ],
  },
};

afterEach(cleanup);

describe("SchemaEditorBanners", () => {
  it("explica conflito de fingerprint na mesma versão sem alegar outra versão", () => {
    render(
      <SchemaEditorBanners
        helpDismissed
        onDismissHelp={() => {}}
        canRecover={false}
        onRecover={() => {}}
        isPending={false}
        draftConflict={conflict}
        currentVersion="0.2.0"
        storageAvailable
        draftPersisted
        onApplyDraft={() => {}}
        onDiscardDraft={() => {}}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "O conteúdo-base da v0.2.0 mudou desde a criação do rascunho",
    );
    expect(alert.textContent).toContain(
      "O rascunho continua salvo neste navegador",
    );
  });

  it("avisa quando o conflito existe apenas em memória e mantém ações acessíveis", async () => {
    const onApplyDraft = vi.fn();
    const onDiscardDraft = vi.fn();
    render(
      <SchemaEditorBanners
        helpDismissed
        onDismissHelp={() => {}}
        canRecover={false}
        onRecover={() => {}}
        isPending={false}
        draftConflict={{
          ...conflict,
          draft: { ...conflict.draft, baseVersion: "0.1.0" },
        }}
        currentVersion="0.2.0"
        storageAvailable={false}
        draftPersisted={false}
        onApplyDraft={onApplyDraft}
        onDiscardDraft={onDiscardDraft}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "O armazenamento local está indisponível; fechar, recarregar ou navegar pode perdê-lo",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Aplicar para revisar" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(onApplyDraft).toHaveBeenCalledOnce();
    expect(onDiscardDraft).toHaveBeenCalledOnce();
  });
});
