// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemaEditorDialogs } from "../SchemaEditorDialogs";
import { mergeSchemas, unresolvedSchemaConflicts } from "@/lib/schema-merge";
import { SCHEMA_DRAFT_FORMAT_VERSION } from "@/lib/schema-draft";
import type { SchemaDraftConflict } from "@/hooks/useSchemaDraft";
import type { PydanticField } from "@/lib/types";

const base: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "Original" },
];
const local = [{ ...base[0], description: "Minha descrição" }];
const remote = [{ ...base[0], description: "Descrição salva" }];

function makeConflict(resolution?: "local" | "remote"): SchemaDraftConflict {
  const unresolved = mergeSchemas(base, local, remote);
  const id = unresolved.conflicts[0].id;
  return {
    draft: {
      formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
      writeToken: "draft-1",
      base: { fields: base, version: "0.1.0", revision: 1 },
      fields: local,
    },
    remote: { fields: remote, version: "0.2.0", revision: 2 },
    merge: resolution
      ? mergeSchemas(base, local, remote, { [id]: resolution })
      : unresolved,
  };
}

function renderDialogs(conflict: SchemaDraftConflict) {
  const onResolveConflict = vi.fn();
  const onApplyResolvedDraft = vi.fn();
  const view = render(
    <SchemaEditorDialogs
      backfillOpen={false}
      onBackfillOpenChange={() => {}}
      onConfirmBackfill={() => {}}
      majorOpen={false}
      onMajorOpenChange={() => {}}
      onConfirmPublishMajor={() => {}}
      isPending={false}
      currentVersion="0.2.0"
      conflict={conflict}
      conflictCount={unresolvedSchemaConflicts(conflict.merge).length}
      onResolveConflict={onResolveConflict}
      onApplyResolvedDraft={onApplyResolvedDraft}
      onDiscardConflictingDraft={() => {}}
    />,
  );
  return { ...view, onResolveConflict, onApplyResolvedDraft };
}

afterEach(cleanup);

describe("SchemaEditorDialogs — merge concorrente", () => {
  it("expõe escolhas nomeadas e impede aplicar enquanto houver conflito", async () => {
    const conflict = makeConflict();
    const { onResolveConflict } = renderDialogs(conflict);

    expect(screen.getByRole("dialog", { name: "Resolver alterações concorrentes" })).toBeTruthy();
    expect(screen.getByText("Minha descrição")).toBeTruthy();
    expect(screen.getByText("Descrição salva")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Aplicar merge para revisar" }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: /Minha alteração/ }));
    expect(onResolveConflict).toHaveBeenCalledWith(
      conflict.merge.conflicts[0].id,
      "local",
    );
  });

  it("libera a confirmação somente depois de todas as escolhas", async () => {
    const { onApplyResolvedDraft } = renderDialogs(makeConflict("remote"));
    const apply = screen.getByRole("button", { name: "Aplicar merge para revisar" });
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(apply);
    expect(onApplyResolvedDraft).toHaveBeenCalledOnce();
  });
});
