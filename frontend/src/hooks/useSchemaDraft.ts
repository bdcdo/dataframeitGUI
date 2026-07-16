"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SCHEMA_DRAFT_FORMAT_VERSION,
  parseSchemaDraft,
  schemaDraftTokenMatches,
  type SchemaDraftEnvelope,
} from "@/lib/schema-draft";
import {
  mergeSchemas,
  type SchemaMergeChoice,
  type SchemaMergeResolutions,
  type SchemaMergeResult,
} from "@/lib/schema-merge";
import { serializeSchemaFields } from "@/lib/schema-utils";
import type {
  PydanticField,
  SchemaBaselineIdentity,
  SchemaSnapshot,
} from "@/lib/types";

const DRAFT_KEY_PREFIX = "dataframeit:schema-draft:";
const DRAFT_DEBOUNCE_MS = 300;
const subscribeToNothing = () => () => {};

interface UseSchemaDraftParams {
  projectId: string;
  initialFields: PydanticField[];
  currentVersion: string;
  currentRevision: number;
}

interface SchemaDraftSubmission {
  fields: PydanticField[];
  expectedBaseline: SchemaBaselineIdentity;
  writeToken: string | null;
}

export interface SchemaDraftConflict {
  draft: SchemaDraftEnvelope;
  remote: SchemaSnapshot;
  merge: SchemaMergeResult;
}

interface StateBase {
  fields: PydanticField[];
  baseline: SchemaSnapshot;
  recoveredDraft: boolean;
  storageAvailable: boolean;
}

interface CleanState extends StateBase {
  kind: "clean";
}

interface DirtyPersistedState extends StateBase {
  kind: "dirty-persisted";
  draft: SchemaDraftEnvelope;
}

interface DirtyMemoryState extends StateBase {
  kind: "dirty-memory";
  draft: SchemaDraftEnvelope;
  persistedWriteToken: string | null;
}

interface ConflictState extends StateBase {
  kind: "conflict";
  conflict: SchemaDraftConflict;
  resolutions: SchemaMergeResolutions;
  draftPersisted: boolean;
  persistedWriteToken: string | null;
}

type SchemaDraftState =
  | CleanState
  | DirtyPersistedState
  | DirtyMemoryState
  | ConflictState;

interface StorageRead {
  available: boolean;
  draft: SchemaDraftEnvelope | null;
}

interface StorageMutation {
  available: boolean;
  changed: boolean;
}

export function schemaDraftStorageKey(projectId: string): string {
  return `${DRAFT_KEY_PREFIX}${projectId}`;
}

function baselineIdentity(snapshot: SchemaSnapshot): SchemaBaselineIdentity {
  return { version: snapshot.version, revision: snapshot.revision };
}

function sameBaseline(
  left: SchemaBaselineIdentity,
  right: SchemaBaselineIdentity,
): boolean {
  return left.version === right.version && left.revision === right.revision;
}

function sameFields(left: PydanticField[], right: PydanticField[]): boolean {
  return serializeSchemaFields(left) === serializeSchemaFields(right);
}

function readStoredDraft(projectId: string): StorageRead {
  if (typeof window === "undefined") return { available: false, draft: null };
  try {
    return {
      available: true,
      draft: parseSchemaDraft(
        window.localStorage.getItem(schemaDraftStorageKey(projectId)),
      ),
    };
  } catch {
    return { available: false, draft: null };
  }
}

function writeDraft(
  projectId: string,
  draft: SchemaDraftEnvelope,
): StorageMutation {
  if (typeof window === "undefined") return { available: false, changed: false };
  try {
    window.localStorage.setItem(schemaDraftStorageKey(projectId), JSON.stringify(draft));
    return { available: true, changed: true };
  } catch {
    return { available: false, changed: false };
  }
}

function deleteDraftIfTokenMatches(
  projectId: string,
  writeToken: string | null,
): StorageMutation {
  if (!writeToken) return { available: true, changed: false };
  if (typeof window === "undefined") return { available: false, changed: false };
  try {
    const stored = parseSchemaDraft(
      window.localStorage.getItem(schemaDraftStorageKey(projectId)),
    );
    if (!stored || !schemaDraftTokenMatches(stored, writeToken)) {
      return { available: true, changed: false };
    }
    window.localStorage.removeItem(schemaDraftStorageKey(projectId));
    return { available: true, changed: true };
  } catch {
    return { available: false, changed: false };
  }
}

function createDraft(
  fields: PydanticField[],
  base: SchemaSnapshot,
): SchemaDraftEnvelope {
  return {
    formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
    writeToken: globalThis.crypto.randomUUID(),
    updatedAt: Date.now(),
    base,
    fields,
  };
}

function dirtyState(
  draft: SchemaDraftEnvelope,
  baseline: SchemaSnapshot,
  recoveredDraft: boolean,
  persistence: StorageMutation,
  replacedWriteToken: string | null = null,
): DirtyPersistedState | DirtyMemoryState {
  const shared = {
    fields: draft.fields,
    baseline,
    recoveredDraft,
    storageAvailable: persistence.available,
    draft,
  };
  return persistence.changed
    ? { ...shared, kind: "dirty-persisted" }
    : {
        ...shared,
        kind: "dirty-memory",
        persistedWriteToken: replacedWriteToken,
      };
}

function persistedWriteToken(state: SchemaDraftState): string | null {
  if (state.kind === "dirty-persisted") return state.draft.writeToken;
  if (state.kind === "dirty-memory" || state.kind === "conflict") {
    return state.persistedWriteToken;
  }
  return null;
}

function initialState({
  projectId,
  initialFields,
  currentVersion,
  currentRevision,
}: UseSchemaDraftParams): SchemaDraftState {
  const baseline: SchemaSnapshot = {
    fields: initialFields,
    version: currentVersion,
    revision: currentRevision,
  };
  const stored = readStoredDraft(projectId);
  if (!stored.draft) {
    return {
      kind: "clean",
      fields: initialFields,
      baseline,
      recoveredDraft: false,
      storageAvailable: stored.available,
    };
  }

  const draft = stored.draft;
  if (sameBaseline(draft.base, baseline)) {
    if (sameFields(draft.fields, baseline.fields)) {
      const deleted = deleteDraftIfTokenMatches(projectId, draft.writeToken);
      return {
        kind: "clean",
        fields: baseline.fields,
        baseline,
        recoveredDraft: false,
        storageAvailable: deleted.available,
      };
    }
    return {
      kind: "dirty-persisted",
      fields: draft.fields,
      baseline,
      recoveredDraft: true,
      storageAvailable: stored.available,
      draft,
    };
  }

  const merge = mergeSchemas(draft.base.fields, draft.fields, baseline.fields);
  if (merge.unresolvedConflictIds.length > 0) {
    return {
      kind: "conflict",
      fields: merge.fields,
      baseline,
      recoveredDraft: true,
      storageAvailable: stored.available,
      conflict: { draft, remote: baseline, merge },
      resolutions: {},
      draftPersisted: true,
      persistedWriteToken: draft.writeToken,
    };
  }
  if (sameFields(merge.fields, baseline.fields)) {
    const deleted = deleteDraftIfTokenMatches(projectId, draft.writeToken);
    return {
      kind: "clean",
      fields: baseline.fields,
      baseline,
      recoveredDraft: false,
      storageAvailable: deleted.available,
    };
  }
  const rebased = createDraft(merge.fields, baseline);
  return dirtyState(
    rebased,
    baseline,
    true,
    writeDraft(projectId, rebased),
    draft.writeToken,
  );
}

function stateAfterFieldsChange(
  current: Exclude<SchemaDraftState, ConflictState>,
  fields: PydanticField[],
  projectId: string,
): SchemaDraftState {
  if (sameFields(fields, current.baseline.fields)) {
    const deleted = deleteDraftIfTokenMatches(projectId, persistedWriteToken(current));
    return {
      kind: "clean",
      fields,
      baseline: current.baseline,
      recoveredDraft: false,
      storageAvailable: deleted.available,
    };
  }
  return {
    kind: "dirty-memory",
    fields,
    baseline: current.baseline,
    recoveredDraft: current.recoveredDraft,
    storageAvailable: current.storageAvailable,
    draft: createDraft(fields, current.baseline),
    persistedWriteToken: persistedWriteToken(current),
  };
}

function stateAfterSave(
  current: SchemaDraftState,
  saved: SchemaSnapshot,
  submittedWriteToken: string | null,
  projectId: string,
): SchemaDraftState {
  if (sameFields(current.fields, saved.fields)) {
    const submittedDraftStillCurrent =
      current.kind === "dirty-memory" &&
      current.draft.writeToken === submittedWriteToken;
    const deleteToken = submittedDraftStillCurrent
      ? current.persistedWriteToken ?? submittedWriteToken
      : submittedWriteToken;
    const deleted = deleteDraftIfTokenMatches(projectId, deleteToken);
    return {
      kind: "clean",
      fields: current.fields,
      baseline: saved,
      recoveredDraft: false,
      storageAvailable: deleted.available,
    };
  }
  const draft = createDraft(current.fields, saved);
  return dirtyState(
    draft,
    saved,
    false,
    writeDraft(projectId, draft),
    persistedWriteToken(current),
  );
}

function stateAfterRemoteChange(
  current: SchemaDraftState,
  remote: SchemaSnapshot,
  projectId: string,
): SchemaDraftState {
  const draft =
    current.kind === "dirty-memory" || current.kind === "dirty-persisted"
      ? current.draft
      : createDraft(current.fields, current.baseline);
  const merge = mergeSchemas(draft.base.fields, draft.fields, remote.fields);
  if (merge.unresolvedConflictIds.length === 0) {
    if (sameFields(merge.fields, remote.fields)) {
      const deleted = deleteDraftIfTokenMatches(
        projectId,
        persistedWriteToken(current) ?? draft.writeToken,
      );
      return {
        kind: "clean",
        fields: remote.fields,
        baseline: remote,
        recoveredDraft: false,
        storageAvailable: deleted.available,
      };
    }
    const rebased = createDraft(merge.fields, remote);
    return dirtyState(
      rebased,
      remote,
      true,
      writeDraft(projectId, rebased),
      persistedWriteToken(current),
    );
  }
  const stored = readStoredDraft(projectId);
  return {
    kind: "conflict",
    fields: merge.fields,
    baseline: remote,
    recoveredDraft: true,
    storageAvailable: stored.available,
    conflict: { draft, remote, merge },
    resolutions: {},
    draftPersisted:
      stored.draft?.writeToken === draft.writeToken ||
      current.kind === "dirty-persisted",
    persistedWriteToken: persistedWriteToken(current),
  };
}

function useDraftPersistenceLifecycle(
  pendingWriteToken: string | null,
  hasUnsavedWork: boolean,
  persistDraft: (writeToken?: string) => void,
): void {
  useEffect(() => {
    if (!pendingWriteToken) return;
    const timer = window.setTimeout(
      () => persistDraft(pendingWriteToken),
      DRAFT_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pendingWriteToken, persistDraft]);

  useEffect(() => {
    const flush = () => persistDraft();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      if (!hasUnsavedWork) return;
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [hasUnsavedWork, persistDraft]);
}

export function useSchemaDraft(params: UseSchemaDraftParams) {
  const { projectId } = params;
  const isHydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const [state, setReactState] = useState<SchemaDraftState>(() => initialState(params));
  const stateRef = useRef(state);

  const setState = useCallback((next: SchemaDraftState) => {
    stateRef.current = next;
    setReactState(next);
  }, []);

  const persistDraft = useCallback(
    (writeToken?: string) => {
      const current = stateRef.current;
      if (current.kind !== "dirty-memory") return;
      if (writeToken && current.draft.writeToken !== writeToken) return;
      const persistence = writeDraft(projectId, current.draft);
      if (persistence.changed) {
        setState({ ...current, kind: "dirty-persisted", storageAvailable: true });
      } else if (current.storageAvailable !== persistence.available) {
        setState({ ...current, storageAvailable: persistence.available });
      }
    },
    [projectId, setState],
  );

  const pendingWriteToken =
    state.kind === "dirty-memory" ? state.draft.writeToken : null;

  const setFields = (fields: PydanticField[]) => {
    const current = stateRef.current;
    if (current.kind === "conflict") return;
    setState(stateAfterFieldsChange(current, fields, projectId));
  };

  const prepareSubmission = (): SchemaDraftSubmission => {
    if (stateRef.current.kind === "conflict") {
      throw new Error("Resolva todos os conflitos antes de salvar o schema.");
    }
    persistDraft();
    const current = stateRef.current;
    return {
      fields: current.fields,
      expectedBaseline: baselineIdentity(current.baseline),
      writeToken:
        current.kind === "dirty-memory" || current.kind === "dirty-persisted"
          ? current.draft.writeToken
          : null,
    };
  };

  const markSaved = (
    saved: SchemaSnapshot,
    submittedWriteToken: string | null,
  ) => {
    setState(
      stateAfterSave(stateRef.current, saved, submittedWriteToken, projectId),
    );
  };

  const registerRemoteConflict = (remote: SchemaSnapshot) => {
    persistDraft();
    setState(stateAfterRemoteChange(stateRef.current, remote, projectId));
  };

  const resolveConflict = (conflictId: string, choice: SchemaMergeChoice) => {
    const current = stateRef.current;
    if (current.kind !== "conflict") return;
    if (!current.conflict.merge.conflicts.some(({ id }) => id === conflictId)) return;
    const resolutions = { ...current.resolutions, [conflictId]: choice };
    const merge = mergeSchemas(
      current.conflict.draft.base.fields,
      current.conflict.draft.fields,
      current.conflict.remote.fields,
      resolutions,
    );
    setState({
      ...current,
      fields: merge.fields,
      conflict: { ...current.conflict, merge },
      resolutions,
    });
  };

  const applyResolvedDraft = (): boolean => {
    const current = stateRef.current;
    if (
      current.kind !== "conflict" ||
      current.conflict.merge.unresolvedConflictIds.length > 0
    ) {
      return false;
    }
    const { remote, merge, draft: previousDraft } = current.conflict;
    if (sameFields(merge.fields, remote.fields)) {
      const deleted = deleteDraftIfTokenMatches(
        projectId,
        current.persistedWriteToken ?? previousDraft.writeToken,
      );
      setState({
        kind: "clean",
        fields: remote.fields,
        baseline: remote,
        recoveredDraft: false,
        storageAvailable: deleted.available,
      });
      return true;
    }
    const draft = createDraft(merge.fields, remote);
    setState(
      dirtyState(
        draft,
        remote,
        true,
        writeDraft(projectId, draft),
        current.persistedWriteToken,
      ),
    );
    return true;
  };

  const discardConflictingDraft = () => {
    const current = stateRef.current;
    if (current.kind !== "conflict") return;
    const deleted = deleteDraftIfTokenMatches(
      projectId,
      current.persistedWriteToken ?? current.conflict.draft.writeToken,
    );
    setState({
      kind: "clean",
      fields: current.conflict.remote.fields,
      baseline: current.conflict.remote,
      recoveredDraft: false,
      storageAvailable: deleted.available,
    });
  };

  const isDirty =
    state.kind === "dirty-memory" ||
    state.kind === "dirty-persisted" ||
    (state.kind === "conflict" && !sameFields(state.fields, state.baseline.fields));
  const hasUnsavedWork = isDirty || state.kind === "conflict";
  useDraftPersistenceLifecycle(pendingWriteToken, hasUnsavedWork, persistDraft);

  return {
    fields: state.fields,
    setFields,
    isDirty,
    recoveredDraft: state.recoveredDraft,
    savedVersion: state.baseline.version,
    baseline: baselineIdentity(state.baseline),
    conflict: state.kind === "conflict" ? state.conflict : null,
    storageAvailable: state.storageAvailable,
    draftPersisted:
      state.kind === "dirty-persisted" ||
      (state.kind === "conflict" && state.draftPersisted),
    draftState: state.kind,
    prepareSubmission,
    markSaved,
    registerRemoteConflict,
    resolveConflict,
    applyResolvedDraft,
    discardConflictingDraft,
    isHydrated,
  };
}
