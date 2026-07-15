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
  schemaDraftToken,
  schemaDraftTokenMatches,
  type SchemaDraftEnvelope,
  type SchemaDraftToken,
} from "@/lib/schema-draft";
import {
  schemaBaselineIdentity,
  schemaFieldsFingerprint,
} from "@/lib/schema-utils";
import type {
  PydanticField,
  SchemaBaselineIdentity,
  SchemaSnapshot,
} from "@/lib/types";

const DRAFT_KEY_PREFIX = "dataframeit:schema-draft:";
const subscribeToNothing = () => () => {};

interface UseSchemaDraftParams {
  projectId: string;
  initialFields: PydanticField[];
  currentVersion: string;
}

export interface SchemaDraftConflict {
  draft: SchemaDraftEnvelope;
  currentVersion: string;
}

interface SchemaDraftSubmission {
  fields: PydanticField[];
  expectedBaseline: SchemaBaselineIdentity;
  draftToken: SchemaDraftToken | null;
}

interface SchemaDraftSession {
  fields: PydanticField[];
  baseline: SchemaBaselineIdentity;
  recoveredDraft: boolean;
  conflict: SchemaDraftConflict | null;
  storageAvailable: boolean;
  draftPersisted: boolean;
}

interface StorageRead {
  available: boolean;
  draft: SchemaDraftEnvelope | null;
}

interface StorageWrite {
  available: boolean;
  written: boolean;
}

interface StorageMatch {
  available: boolean;
  matches: boolean;
}

interface SchemaDraftRuntime {
  fields: PydanticField[];
  baseline: SchemaBaselineIdentity;
  activeDraft: SchemaDraftEnvelope | null;
  conflict: SchemaDraftConflict | null;
}

interface PreservedConflictDraft {
  draft: SchemaDraftEnvelope;
  storageAvailable: boolean;
  persisted: boolean;
}

export function schemaDraftStoragePrefix(projectId: string): string {
  return `${DRAFT_KEY_PREFIX}${projectId}:`;
}

export function schemaDraftStorageKey(projectId: string, draftId: string): string {
  return `${schemaDraftStoragePrefix(projectId)}${draftId}`;
}

function readDraftById(
  storage: Storage,
  projectId: string,
  draftId: string,
): SchemaDraftEnvelope | null {
  const draft = parseSchemaDraft(
    storage.getItem(schemaDraftStorageKey(projectId, draftId)),
  );
  return draft?.draftId === draftId ? draft : null;
}

function readStoredDraft(projectId: string): StorageRead {
  if (typeof window === "undefined") return { available: false, draft: null };
  try {
    const prefix = schemaDraftStoragePrefix(projectId);
    const drafts: SchemaDraftEnvelope[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const draftId = key.slice(prefix.length);
      const draft = readDraftById(window.localStorage, projectId, draftId);
      if (draft) drafts.push(draft);
    }
    drafts.sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        right.revision - left.revision ||
        right.draftId.localeCompare(left.draftId),
    );
    return { available: true, draft: drafts[0] ?? null };
  } catch {
    return { available: false, draft: null };
  }
}

function storedDraftTokenMatches(
  projectId: string,
  expected: SchemaDraftToken,
): StorageMatch {
  if (typeof window === "undefined") return { available: false, matches: false };
  try {
    const current = readDraftById(
      window.localStorage,
      projectId,
      expected.draftId,
    );
    return {
      available: true,
      matches: Boolean(current && schemaDraftTokenMatches(current, expected)),
    };
  } catch {
    return { available: false, matches: false };
  }
}

function writeOwnedDraft(
  projectId: string,
  next: SchemaDraftEnvelope,
  expected: SchemaDraftToken | null,
): StorageWrite {
  if (typeof window === "undefined") return { available: false, written: false };
  try {
    const currentOwn = readDraftById(window.localStorage, projectId, next.draftId);
    if (
      currentOwn &&
      (!expected ||
        expected.draftId !== next.draftId ||
        !schemaDraftTokenMatches(currentOwn, expected))
    ) {
      return { available: true, written: false };
    }
    window.localStorage.setItem(
      schemaDraftStorageKey(projectId, next.draftId),
      JSON.stringify(next),
    );
    if (expected && expected.draftId !== next.draftId) {
      compareAndDeleteDraft(projectId, expected);
    }
    return { available: true, written: true };
  } catch {
    return { available: false, written: false };
  }
}

function compareAndDeleteDraft(
  projectId: string,
  expected: SchemaDraftToken | null,
): StorageWrite {
  if (!expected) return { available: true, written: false };
  if (typeof window === "undefined") return { available: false, written: false };
  try {
    const current = readDraftById(window.localStorage, projectId, expected.draftId);
    if (!current || !schemaDraftTokenMatches(current, expected)) {
      return { available: true, written: false };
    }
    window.localStorage.removeItem(schemaDraftStorageKey(projectId, expected.draftId));
    return { available: true, written: true };
  } catch {
    return { available: false, written: false };
  }
}

function createDraft(
  fields: PydanticField[],
  baseline: SchemaBaselineIdentity,
  previous: SchemaDraftEnvelope | null,
  ownerDraftId: string,
): SchemaDraftEnvelope {
  return {
    formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
    draftId: ownerDraftId,
    revision: previous?.draftId === ownerDraftId ? previous.revision + 1 : 1,
    updatedAt: Date.now(),
    baseVersion: baseline.version,
    baseFingerprint: baseline.fingerprint,
    fields,
  };
}

function preserveDraftForConflict({
  projectId,
  currentFields,
  activeDraft,
  baseline,
  ownerDraftId,
}: {
  projectId: string;
  currentFields: PydanticField[];
  activeDraft: SchemaDraftEnvelope | null;
  baseline: SchemaBaselineIdentity;
  ownerDraftId: string;
}): PreservedConflictDraft {
  const token = activeDraft ? schemaDraftToken(activeDraft) : null;
  const storedMatch = token
    ? storedDraftTokenMatches(projectId, token)
    : { available: true, matches: false };
  const matchesCurrentFields = activeDraft
    ? schemaFieldsFingerprint(activeDraft.fields) ===
      schemaFieldsFingerprint(currentFields)
    : false;

  if (activeDraft && storedMatch.matches && matchesCurrentFields) {
    return {
      draft: activeDraft,
      storageAvailable: storedMatch.available,
      persisted: true,
    };
  }

  const draft = createDraft(
    currentFields,
    baseline,
    activeDraft,
    ownerDraftId,
  );
  const write = writeOwnedDraft(projectId, draft, token);
  return {
    draft,
    storageAvailable: write.available,
    persisted: write.written,
  };
}

function initialSession({
  projectId,
  initialFields,
  currentVersion,
}: UseSchemaDraftParams): {
  session: SchemaDraftSession;
  activeDraft: SchemaDraftEnvelope | null;
} {
  const baseline = schemaBaselineIdentity(initialFields, currentVersion);
  const stored = readStoredDraft(projectId);
  const draft = stored.draft;
  const sameBase =
    draft?.baseVersion === baseline.version &&
    draft.baseFingerprint === baseline.fingerprint;
  const hasDraftChanges =
    draft !== null && schemaFieldsFingerprint(draft.fields) !== baseline.fingerprint;

  if (draft && sameBase) {
    return {
      session: {
        fields: hasDraftChanges ? draft.fields : initialFields,
        baseline,
        recoveredDraft: hasDraftChanges,
        conflict: null,
        storageAvailable: stored.available,
        draftPersisted: true,
      },
      activeDraft: draft,
    };
  }

  return {
    session: {
      fields: initialFields,
      baseline,
      recoveredDraft: false,
      conflict: draft
        ? { draft, currentVersion: baseline.version }
        : null,
      storageAvailable: stored.available,
      draftPersisted: draft !== null,
    },
    activeDraft: null,
  };
}

export function useSchemaDraft(params: UseSchemaDraftParams) {
  const { projectId } = params;
  const isHydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const [bootstrap] = useState(() => initialSession(params));
  const [session, setSession] = useState(bootstrap.session);
  const [ownerDraftId] = useState(() => globalThis.crypto.randomUUID());
  const runtimeRef = useRef<SchemaDraftRuntime>({
    fields: session.fields,
    baseline: session.baseline,
    activeDraft: bootstrap.activeDraft,
    conflict: session.conflict,
  });

  const setFields = useCallback(
    (fields: PydanticField[]) => {
      const previous = runtimeRef.current.activeDraft;
      if (
        schemaFieldsFingerprint(fields) === runtimeRef.current.baseline.fingerprint
      ) {
        const deleted = compareAndDeleteDraft(
          projectId,
          previous ? schemaDraftToken(previous) : null,
        );
        runtimeRef.current.fields = fields;
        runtimeRef.current.activeDraft = null;
        setSession((current) => ({
          ...current,
          fields,
          recoveredDraft: false,
          storageAvailable: deleted.available,
          draftPersisted: false,
        }));
        return;
      }
      const next = createDraft(
        fields,
        runtimeRef.current.baseline,
        previous,
        ownerDraftId,
      );
      const persisted = writeOwnedDraft(
        projectId,
        next,
        previous ? schemaDraftToken(previous) : null,
      );
      runtimeRef.current.fields = fields;
      runtimeRef.current.activeDraft = next;
      setSession((current) => ({
        ...current,
        fields,
        storageAvailable: persisted.available,
        draftPersisted: persisted.written,
      }));
    },
    [ownerDraftId, projectId],
  );

  const prepareSubmission = useCallback((): SchemaDraftSubmission => ({
    fields: runtimeRef.current.fields,
    expectedBaseline: runtimeRef.current.baseline,
    draftToken: runtimeRef.current.activeDraft
      ? schemaDraftToken(runtimeRef.current.activeDraft)
      : null,
  }), []);

  const markSaved = useCallback(
    (saved: SchemaSnapshot, submittedToken: SchemaDraftToken | null) => {
      const baseline = schemaBaselineIdentity(saved.fields, saved.version);
      runtimeRef.current.baseline = baseline;
      const currentFields = runtimeRef.current.fields;
      const stillDirty = schemaFieldsFingerprint(currentFields) !== baseline.fingerprint;
      let persistence: StorageWrite;

      if (stillDirty) {
        const previous = runtimeRef.current.activeDraft;
        const rebased = createDraft(
          currentFields,
          baseline,
          previous,
          ownerDraftId,
        );
        persistence = writeOwnedDraft(
          projectId,
          rebased,
          previous ? schemaDraftToken(previous) : null,
        );
        runtimeRef.current.activeDraft = rebased;
      } else {
        const currentToken = runtimeRef.current.activeDraft
          ? schemaDraftToken(runtimeRef.current.activeDraft)
          : submittedToken;
        persistence = compareAndDeleteDraft(projectId, currentToken);
        runtimeRef.current.activeDraft = null;
      }

      runtimeRef.current.conflict = null;
      setSession((current) => ({
        ...current,
        baseline,
        recoveredDraft: false,
        conflict: null,
        storageAvailable: persistence.available,
        draftPersisted: stillDirty
          ? persistence.written
          : false,
      }));
    },
    [ownerDraftId, projectId],
  );

  const registerRemoteConflict = useCallback(
    (remote: SchemaSnapshot) => {
      const preserved = preserveDraftForConflict({
        projectId,
        currentFields: runtimeRef.current.fields,
        activeDraft: runtimeRef.current.activeDraft,
        baseline: runtimeRef.current.baseline,
        ownerDraftId,
      });

      const baseline = schemaBaselineIdentity(remote.fields, remote.version);
      const conflict = {
        draft: preserved.draft,
        currentVersion: remote.version,
      };
      runtimeRef.current.fields = remote.fields;
      runtimeRef.current.baseline = baseline;
      runtimeRef.current.activeDraft = null;
      runtimeRef.current.conflict = conflict;
      setSession((current) => ({
        ...current,
        fields: remote.fields,
        baseline,
        recoveredDraft: false,
        conflict,
        storageAvailable: preserved.storageAvailable,
        draftPersisted: preserved.persisted,
      }));
    },
    [ownerDraftId, projectId],
  );

  const applyConflictingDraft = useCallback(() => {
    const conflict = runtimeRef.current.conflict;
    if (!conflict) return;
    const previous = conflict.draft;
    const applied = createDraft(
      previous.fields,
      runtimeRef.current.baseline,
      previous,
      ownerDraftId,
    );
    const persistence = writeOwnedDraft(
      projectId,
      applied,
      schemaDraftToken(previous),
    );
    runtimeRef.current.fields = applied.fields;
    runtimeRef.current.activeDraft = applied;
    runtimeRef.current.conflict = null;
    setSession((current) => ({
      ...current,
      fields: applied.fields,
      recoveredDraft: true,
      conflict: null,
      storageAvailable: persistence.available,
      draftPersisted: persistence.written,
    }));
  }, [ownerDraftId, projectId]);

  const discardConflictingDraft = useCallback(() => {
    const conflict = runtimeRef.current.conflict;
    if (!conflict) return;
    const deleted = compareAndDeleteDraft(
      projectId,
      schemaDraftToken(conflict.draft),
    );
    runtimeRef.current.conflict = null;
    setSession((current) => ({
      ...current,
      conflict: null,
      storageAvailable: deleted.available,
      draftPersisted: false,
    }));
  }, [projectId]);

  const isDirty =
    schemaFieldsFingerprint(session.fields) !== session.baseline.fingerprint;
  const hasUnsavedWork = isDirty || session.conflict !== null;

  useEffect(() => {
    if (!hasUnsavedWork) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedWork]);

  return {
    fields: session.fields,
    setFields,
    isDirty,
    recoveredDraft: session.recoveredDraft,
    savedVersion: session.baseline.version,
    baseline: session.baseline,
    conflict: session.conflict,
    storageAvailable: session.storageAvailable,
    draftPersisted: session.draftPersisted,
    prepareSubmission,
    markSaved,
    registerRemoteConflict,
    applyConflictingDraft,
    discardConflictingDraft,
    isHydrated,
  };
}
