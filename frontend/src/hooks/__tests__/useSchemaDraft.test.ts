// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useSchemaDraft,
  schemaDraftStorageKey,
  schemaDraftStoragePrefix,
} from "../useSchemaDraft";
import {
  parseSchemaDraft,
  type SchemaDraftEnvelope,
  type SchemaDraftToken,
} from "@/lib/schema-draft";
import { schemaBaselineIdentity } from "@/lib/schema-utils";
import type { PydanticField, SchemaSnapshot } from "@/lib/types";

const BASE_FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "Pergunta" },
];
const EDITED_FIELDS: PydanticField[] = [
  { ...BASE_FIELDS[0], description: "Pergunta editada" },
];

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDraft(version = "0.1.0", fields = BASE_FIELDS) {
  return renderHook(() =>
    useSchemaDraft({
      projectId: "project-1",
      initialFields: fields,
      currentVersion: version,
    }),
  );
}

function snapshot(fields: PydanticField[], version: string): SchemaSnapshot {
  return { fields, ...schemaBaselineIdentity(fields, version) };
}

function storedDraft() {
  return storedDrafts()[0] ?? null;
}

function storedDrafts() {
  const prefix = schemaDraftStoragePrefix("project-1");
  return Object.keys(window.localStorage)
    .filter((key) => key.startsWith(prefix))
    .map((key) => parseSchemaDraft(window.localStorage.getItem(key)))
    .filter((draft) => draft !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function startEditedSubmission() {
  const view = renderDraft();
  act(() => view.result.current.setFields(EDITED_FIELDS));
  return {
    view,
    submission: view.result.current.prepareSubmission(),
    submittedDraft: storedDraft()!,
  };
}

function writeStoredDraft(draft: SchemaDraftEnvelope) {
  window.localStorage.setItem(
    schemaDraftStorageKey("project-1", draft.draftId),
    JSON.stringify(draft),
  );
}

function confirmSave(
  view: ReturnType<typeof renderDraft>,
  token: SchemaDraftToken | null,
  fields: PydanticField[] = EDITED_FIELDS,
  version = "0.1.1",
) {
  act(() => view.result.current.markSaved(snapshot(fields, version), token));
}

function startWithUnavailableStorage() {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
  const view = renderDraft();
  act(() => view.result.current.setFields(EDITED_FIELDS));
  return view;
}

describe("useSchemaDraft", () => {
  it("persiste envelope revisionado e recupera draft sobre o mesmo baseline", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));

    expect(first.result.current.isDirty).toBe(true);
    expect(storedDraft()).toMatchObject({
      revision: 1,
      baseVersion: "0.1.0",
      fields: EDITED_FIELDS,
    });

    first.unmount();
    const second = renderDraft();
    expect(second.result.current.fields).toEqual(EDITED_FIELDS);
    expect(second.result.current.recoveredDraft).toBe(true);
    expect(second.result.current.isDirty).toBe(true);
  });

  it("tornar ao baseline remove o draft em vez de persistir um estado redundante", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    expect(storedDraft()).not.toBeNull();

    act(() => view.result.current.setFields(BASE_FIELDS));

    expect(view.result.current.isDirty).toBe(false);
    expect(storedDraft()).toBeNull();
  });

  it("preserva divergência como conflito e só aplica ou descarta por ação explícita", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));
    const original = storedDraft();
    first.unmount();

    const remoteFields = [{ ...BASE_FIELDS[0], description: "Alteração remota" }];
    const changed = renderDraft("0.2.0", remoteFields);
    expect(changed.result.current.fields).toEqual(remoteFields);
    expect(changed.result.current.isDirty).toBe(false);
    expect(changed.result.current.conflict?.draft.fields).toEqual(EDITED_FIELDS);
    expect(storedDraft()).toEqual(original);

    act(() => changed.result.current.applyConflictingDraft());
    expect(changed.result.current.fields).toEqual(EDITED_FIELDS);
    expect(changed.result.current.isDirty).toBe(true);
    expect(storedDraft()).toMatchObject({ revision: 1, baseVersion: "0.2.0" });
    expect(storedDraft()?.draftId).not.toBe(original?.draftId);

    changed.unmount();
    const discardView = renderDraft("0.3.0", remoteFields);
    expect(discardView.result.current.conflict).not.toBeNull();
    act(() => discardView.result.current.discardConflictingDraft());
    expect(discardView.result.current.conflict).toBeNull();
    expect(storedDraft()).toBeNull();
  });

  it("compare-and-delete não apaga revisão mais nova escrita após a submissão", () => {
    const { view, submission, submittedDraft } = startEditedSubmission();
    expect(submittedDraft?.revision).toBe(1);

    const newer = {
      ...submittedDraft!,
      draftId: "outra-instancia",
      revision: 7,
      updatedAt: submittedDraft!.updatedAt + 1,
      fields: [{ ...EDITED_FIELDS[0], help_text: "Outra aba" }],
    };
    writeStoredDraft(newer);
    confirmSave(view, submission.draftToken);

    expect(storedDraft()).toEqual(newer);
  });

  it("compare-and-delete não apaga revisão mais nova com o mesmo draftId", () => {
    const { view, submission, submittedDraft } = startEditedSubmission();
    const newer = {
      ...submittedDraft,
      revision: submittedDraft.revision + 1,
      updatedAt: submittedDraft.updatedAt + 1,
      fields: [{ ...EDITED_FIELDS[0], help_text: "Revisão concorrente" }],
    };
    writeStoredDraft(newer);
    confirmSave(view, submission.draftToken);

    expect(storedDraft()).toEqual(newer);
  });

  it("cada instância possui sua chave e salvar uma não apaga a edição da outra", () => {
    const first = renderDraft();
    const second = renderDraft();
    const firstFields = [{ ...BASE_FIELDS[0], description: "Primeira aba" }];
    const secondFields = [{ ...BASE_FIELDS[0], description: "Segunda aba" }];

    act(() => first.result.current.setFields(firstFields));
    const submission = first.result.current.prepareSubmission();
    act(() => second.result.current.setFields(secondFields));

    expect(storedDrafts()).toHaveLength(2);
    act(() =>
      first.result.current.markSaved(
        snapshot(firstFields, "0.1.1"),
        submission.draftToken,
      ),
    );

    expect(storedDrafts()).toHaveLength(1);
    expect(storedDraft()?.fields).toEqual(secondFields);
  });

  it("descartar conflito não apaga draft mais novo de outra instância", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));
    first.unmount();

    const remoteFields = [{ ...BASE_FIELDS[0], description: "Remota" }];
    const conflicted = renderDraft("0.2.0", remoteFields);
    const newer = {
      ...storedDraft()!,
      draftId: "outra-instancia",
      revision: 9,
      updatedAt: storedDraft()!.updatedAt + 1,
      fields: [{ ...EDITED_FIELDS[0], help_text: "Mais novo" }],
    };
    window.localStorage.setItem(
      schemaDraftStorageKey("project-1", newer.draftId),
      JSON.stringify(newer),
    );

    act(() => conflicted.result.current.discardConflictingDraft());

    expect(storedDraft()).toEqual(newer);
    expect(conflicted.result.current.conflict).toBeNull();
  });

  it("fingerprint remoto divergente na mesma versão também vira conflito", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));
    first.unmount();

    const remoteFields = [{ ...BASE_FIELDS[0], description: "Remota sem bump" }];
    const changed = renderDraft("0.1.0", remoteFields);

    expect(changed.result.current.fields).toEqual(remoteFields);
    expect(changed.result.current.conflict?.draft.fields).toEqual(EDITED_FIELDS);
  });

  it("commit remoto com resposta perdida + edição posterior reaparece como conflito preservado", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));
    const submitted = first.result.current.prepareSubmission();

    // O servidor persistiu `submitted`, mas a resposta se perdeu: o hook não
    // recebeu markSaved e continua corretamente ancorado no baseline antigo.
    const laterFields = [{ ...EDITED_FIELDS[0], help_text: "Depois do envio" }];
    act(() => first.result.current.setFields(laterFields));
    expect(storedDraft()?.revision).toBe(2);
    first.unmount();

    const reloaded = renderDraft("0.1.1", submitted.fields);
    expect(reloaded.result.current.fields).toEqual(submitted.fields);
    expect(reloaded.result.current.isDirty).toBe(false);
    expect(reloaded.result.current.conflict?.draft.fields).toEqual(laterFields);

    act(() => reloaded.result.current.applyConflictingDraft());
    expect(reloaded.result.current.fields).toEqual(laterFields);
    expect(reloaded.result.current.isDirty).toBe(true);
    expect(storedDraft()).toMatchObject({ baseVersion: "0.1.1", revision: 1 });
  });

  it("save mantém e rebasa edição feita enquanto a requisição estava em voo", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const submission = view.result.current.prepareSubmission();
    const laterFields = [{ ...EDITED_FIELDS[0], help_text: "Nova edição" }];
    act(() => view.result.current.setFields(laterFields));

    act(() =>
      view.result.current.markSaved(
        snapshot(submission.fields, "0.1.1"),
        submission.draftToken,
      ),
    );

    expect(view.result.current.fields).toEqual(laterFields);
    expect(view.result.current.isDirty).toBe(true);
    expect(storedDraft()).toMatchObject({
      baseVersion: "0.1.1",
      revision: 3,
      fields: laterFields,
    });
  });

  it("save recria o draft quando o estado atual só diverge após o baseline avançar", () => {
    const { view, submission } = startEditedSubmission();

    // Enquanto o save de EDITED_FIELDS está em voo, o usuário retorna ao
    // baseline antigo. Nesse instante o hook remove corretamente o draft; após
    // o servidor confirmar EDITED_FIELDS, porém, BASE_FIELDS volta a ser uma
    // edição local divergente e precisa ganhar um novo draft.
    act(() => view.result.current.setFields(BASE_FIELDS));
    expect(storedDraft()).toBeNull();

    act(() =>
      view.result.current.markSaved(
        snapshot(submission.fields, "0.1.1"),
        submission.draftToken,
      ),
    );

    expect(view.result.current.fields).toEqual(BASE_FIELDS);
    expect(view.result.current.isDirty).toBe(true);
    expect(storedDraft()).toMatchObject({
      baseVersion: "0.1.1",
      revision: 1,
      fields: BASE_FIELDS,
    });
  });

  it("save remove com segurança a revisão local posterior que coincide com o novo baseline", () => {
    const { view, submission } = startEditedSubmission();
    act(() =>
      view.result.current.setFields([
        { ...EDITED_FIELDS[0], help_text: "Edição durante o save" },
      ]),
    );
    act(() => view.result.current.setFields(EDITED_FIELDS));
    expect(storedDraft()?.revision).toBe(3);

    act(() =>
      view.result.current.markSaved(
        snapshot(submission.fields, "0.1.1"),
        submission.draftToken,
      ),
    );

    expect(view.result.current.isDirty).toBe(false);
    expect(storedDraft()).toBeNull();
  });

  it("beforeunload existe apenas enquanto dirty", () => {
    const view = renderDraft();
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    act(() => view.result.current.setFields(EDITED_FIELDS));
    const submission = view.result.current.prepareSubmission();
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    act(() =>
      view.result.current.markSaved(
        snapshot(EDITED_FIELDS, "0.1.1"),
        submission.draftToken,
      ),
    );
    const savedEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedEvent);
    expect(savedEvent.defaultPrevented).toBe(false);
    expect(storedDraft()).toBeNull();
  });

  it("expõe storage indisponível sem prometer proteção na navegação interna", () => {
    const view = startWithUnavailableStorage();

    expect(view.result.current.isDirty).toBe(true);
    expect(view.result.current.storageAvailable).toBe(false);
    expect(view.result.current.draftPersisted).toBe(false);
  });

  it("mantém beforeunload quando conflito remoto só existe em memória", () => {
    const view = startWithUnavailableStorage();

    const remoteFields = [{ ...BASE_FIELDS[0], description: "Alteração remota" }];
    act(() =>
      view.result.current.registerRemoteConflict(
        snapshot(remoteFields, "0.2.0"),
      ),
    );

    expect(view.result.current.fields).toEqual(remoteFields);
    expect(view.result.current.isDirty).toBe(false);
    expect(view.result.current.conflict?.draft.fields).toEqual(EDITED_FIELDS);
    expect(view.result.current.storageAvailable).toBe(false);
    expect(view.result.current.draftPersisted).toBe(false);

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
