// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  schemaDraftStorageKey,
  useSchemaDraft,
} from "../useSchemaDraft";
import { parseSchemaDraft, type SchemaDraftEnvelope } from "@/lib/schema-draft";
import type { PydanticField, SchemaSnapshot } from "@/lib/types";

const BASE_FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "Pergunta" },
];
const EDITED_FIELDS: PydanticField[] = [
  { ...BASE_FIELDS[0], description: "Pergunta editada" },
];

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderDraft(
  version = "0.1.0",
  revision = 1,
  fields = BASE_FIELDS,
) {
  return renderHook(() =>
    useSchemaDraft({
      projectId: "project-1",
      initialFields: fields,
      currentVersion: version,
      currentRevision: revision,
    }),
  );
}

function snapshot(
  fields: PydanticField[],
  version = "0.1.1",
  revision = 2,
): SchemaSnapshot {
  return { fields, version, revision };
}

function storedDraft(): SchemaDraftEnvelope | null {
  return parseSchemaDraft(
    window.localStorage.getItem(schemaDraftStorageKey("project-1")),
  );
}

function flushDebounce() {
  void act(() => vi.advanceTimersByTime(300));
}

describe("useSchemaDraft", () => {
  it("usa uma chave por projeto, salva com debounce e recupera o draft", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));

    expect(first.result.current.draftState).toBe("dirty-memory");
    expect(first.result.current.draftPersisted).toBe(false);
    expect(storedDraft()).toBeNull();
    flushDebounce();

    expect(Object.keys(window.localStorage)).toEqual([
      schemaDraftStorageKey("project-1"),
    ]);
    expect(storedDraft()).toMatchObject({
      formatVersion: 3,
      base: { fields: BASE_FIELDS, version: "0.1.0", revision: 1 },
      fields: EDITED_FIELDS,
    });
    expect(first.result.current.draftState).toBe("dirty-persisted");

    first.unmount();
    const second = renderDraft();
    expect(second.result.current.fields).toEqual(EDITED_FIELDS);
    expect(second.result.current.recoveredDraft).toBe(true);
  });

  it("substitui o mesmo envelope em edições sucessivas", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    const firstToken = storedDraft()?.writeToken;

    const later = [{ ...EDITED_FIELDS[0], help_text: "Ajuda" }];
    act(() => view.result.current.setFields(later));
    flushDebounce();

    expect(Object.keys(window.localStorage)).toHaveLength(1);
    expect(storedDraft()?.writeToken).not.toBe(firstToken);
    expect(storedDraft()?.fields).toEqual(later);
  });

  it("remove o token persistido substituído ao reverter antes do debounce", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    const persistedToken = storedDraft()?.writeToken;

    act(() =>
      view.result.current.setFields([
        { ...EDITED_FIELDS[0], help_text: "ainda em memória" },
      ]),
    );
    expect(view.result.current.draftState).toBe("dirty-memory");
    expect(storedDraft()?.writeToken).toBe(persistedToken);

    act(() => view.result.current.setFields(BASE_FIELDS));
    expect(storedDraft()).toBeNull();

    view.unmount();
    const reloaded = renderDraft();
    expect(reloaded.result.current.fields).toEqual(BASE_FIELDS);
    expect(reloaded.result.current.recoveredDraft).toBe(false);
  });

  it("faz flush em pagehide, visibilitychange e beforeunload", () => {
    const pagehide = renderDraft();
    act(() => pagehide.result.current.setFields(EDITED_FIELDS));
    void act(() => window.dispatchEvent(new Event("pagehide")));
    expect(storedDraft()?.fields).toEqual(EDITED_FIELDS);
    pagehide.unmount();

    window.localStorage.clear();
    const visibility = renderDraft();
    act(() => visibility.result.current.setFields(EDITED_FIELDS));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    void act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(storedDraft()?.fields).toEqual(EDITED_FIELDS);
    visibility.unmount();

    window.localStorage.clear();
    const unload = renderDraft();
    act(() => unload.result.current.setFields(EDITED_FIELDS));
    const event = new Event("beforeunload", { cancelable: true });
    void act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(storedDraft()?.fields).toEqual(EDITED_FIELDS);
  });

  it("não avança persistência após falha transitória e tenta novamente na edição seguinte", () => {
    const originalSetItem = Storage.prototype.setItem;
    let fail = true;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (fail) {
        fail = false;
        throw new DOMException("quota", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    });
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    flushDebounce();

    expect(view.result.current.draftState).toBe("dirty-memory");
    expect(view.result.current.storageAvailable).toBe(false);
    expect(storedDraft()).toBeNull();

    const later = [{ ...EDITED_FIELDS[0], help_text: "Segunda edição" }];
    act(() => view.result.current.setFields(later));
    flushDebounce();
    expect(view.result.current.draftState).toBe("dirty-persisted");
    expect(view.result.current.storageAvailable).toBe(true);
    expect(storedDraft()?.fields).toEqual(later);
  });

  it("remove o draft quando os campos retornam ao baseline", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    act(() => view.result.current.setFields(BASE_FIELDS));

    expect(view.result.current.isDirty).toBe(false);
    expect(view.result.current.draftState).toBe("clean");
    expect(storedDraft()).toBeNull();
  });

  it("não apaga envelope com token mais novo ao concluir save", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const submission = view.result.current.prepareSubmission();
    const submitted = storedDraft()!;
    const newer: SchemaDraftEnvelope = {
      ...submitted,
      writeToken: "outra-aba",
      updatedAt: submitted.updatedAt + 1,
      fields: [{ ...EDITED_FIELDS[0], help_text: "Outra aba" }],
    };
    window.localStorage.setItem(
      schemaDraftStorageKey("project-1"),
      JSON.stringify(newer),
    );

    act(() => view.result.current.markSaved(snapshot(EDITED_FIELDS), submission.writeToken));
    expect(storedDraft()).toEqual(newer);
  });

  it("preserva e rebasa edição feita durante o save", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const submission = view.result.current.prepareSubmission();
    const later = [{ ...EDITED_FIELDS[0], help_text: "Durante o save" }];
    act(() => view.result.current.setFields(later));

    act(() =>
      view.result.current.markSaved(
        snapshot(submission.fields, "0.1.1", 2),
        submission.writeToken,
      ),
    );

    expect(view.result.current.fields).toEqual(later);
    expect(view.result.current.isDirty).toBe(true);
    expect(storedDraft()).toMatchObject({
      base: { fields: submission.fields, version: "0.1.1", revision: 2 },
      fields: later,
    });
  });

  it("auto-mescla conflito remoto não sobreposto e rebasa o draft", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const remoteFields = [{ ...BASE_FIELDS[0], help_text: "Ajuda remota" }];

    act(() =>
      view.result.current.registerRemoteConflict(
        snapshot(remoteFields, "0.1.1", 2),
      ),
    );

    expect(view.result.current.conflict).toBeNull();
    expect(view.result.current.fields).toEqual([
      { ...EDITED_FIELDS[0], help_text: "Ajuda remota" },
    ]);
    expect(storedDraft()?.base.revision).toBe(2);
  });

  it("exige resolução explícita antes de aplicar merge conflitante", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const remoteFields = [{ ...BASE_FIELDS[0], description: "Pergunta remota" }];
    act(() =>
      view.result.current.registerRemoteConflict(
        snapshot(remoteFields, "0.1.1", 2),
      ),
    );

    const conflictId = view.result.current.conflict!.merge.unresolvedConflictIds[0];
    expect(view.result.current.fields).toEqual(remoteFields);
    expect(view.result.current.applyResolvedDraft()).toBe(false);

    act(() => view.result.current.resolveConflict(conflictId, "local"));
    expect(view.result.current.conflict?.merge.unresolvedConflictIds).toEqual([]);
    expect(view.result.current.fields).toEqual(EDITED_FIELDS);
    act(() => expect(view.result.current.applyResolvedDraft()).toBe(true));

    expect(view.result.current.conflict).toBeNull();
    expect(view.result.current.baseline).toEqual({ version: "0.1.1", revision: 2 });
    expect(storedDraft()).toMatchObject({
      base: { fields: remoteFields, version: "0.1.1", revision: 2 },
      fields: EDITED_FIELDS,
    });
  });

  it("recupera como conflito quando o baseline persistido ficou antigo", () => {
    const first = renderDraft();
    act(() => first.result.current.setFields(EDITED_FIELDS));
    flushDebounce();
    first.unmount();

    const remoteFields = [{ ...BASE_FIELDS[0], description: "Remota" }];
    const reloaded = renderDraft("0.1.1", 2, remoteFields);
    expect(reloaded.result.current.draftState).toBe("conflict");
    expect(reloaded.result.current.conflict?.merge.unresolvedConflictIds).toHaveLength(1);

    act(() => reloaded.result.current.discardConflictingDraft());
    expect(reloaded.result.current.fields).toEqual(remoteFields);
    expect(storedDraft()).toBeNull();
  });

  it("beforeunload fica inativo após save limpo", () => {
    const view = renderDraft();
    act(() => view.result.current.setFields(EDITED_FIELDS));
    const submission = view.result.current.prepareSubmission();
    act(() =>
      view.result.current.markSaved(snapshot(EDITED_FIELDS), submission.writeToken),
    );

    const event = new Event("beforeunload", { cancelable: true });
    void act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });
});
