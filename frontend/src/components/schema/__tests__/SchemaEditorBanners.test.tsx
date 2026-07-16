// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_DRAFT_FORMAT_VERSION } from "@/lib/schema-draft";
import { mergeSchemas } from "@/lib/schema-merge";
import { SchemaEditorBanners } from "../SchemaEditorBanners";
import type { SchemaDraftConflict } from "@/hooks/useSchemaDraft";
import type { PydanticField } from "@/lib/types";

const base: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "Original" },
];
const local = [{ ...base[0], description: "Local" }];
const remote = [{ ...base[0], description: "Remota" }];
const conflict: SchemaDraftConflict = {
  draft: {
    formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
    writeToken: "draft-1",
    updatedAt: 1,
    base: { fields: base, version: "0.1.0", revision: 1 },
    fields: local,
  },
  remote: { fields: remote, version: "0.2.0", revision: 2 },
  merge: mergeSchemas(base, local, remote),
};

afterEach(cleanup);

describe("SchemaEditorBanners", () => {
  it("explica revisões e quantifica as colisões sem aplicar o rascunho cegamente", () => {
    render(
      <SchemaEditorBanners
        helpDismissed
        onDismissHelp={() => {}}
        canRecover={false}
        onRecover={() => {}}
        isPending={false}
        draftConflict={conflict}
        storageAvailable
        draftPersisted
        onDiscardDraft={() => {}}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("v0.1.0, revisão 1");
    expect(alert.textContent).toContain("v0.2.0, revisão 2");
    expect(alert.textContent).toContain("1 colisões");
    expect(screen.queryByRole("button", { name: /aplicar/i })).toBeNull();
  });

  it("avisa quando o conflito existe apenas em memória e permite descartar", async () => {
    const onDiscardDraft = vi.fn();
    render(
      <SchemaEditorBanners
        helpDismissed
        onDismissHelp={() => {}}
        canRecover={false}
        onRecover={() => {}}
        isPending={false}
        draftConflict={conflict}
        storageAvailable={false}
        draftPersisted={false}
        onDiscardDraft={onDiscardDraft}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "O armazenamento local está indisponível",
    );
    await userEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(onDiscardDraft).toHaveBeenCalledOnce();
  });
});
