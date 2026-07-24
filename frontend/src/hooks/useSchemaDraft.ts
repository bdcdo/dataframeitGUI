"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SCHEMA_DRAFT_FORMAT_VERSION,
  convertSchemaDraftV4,
  readSchemaDraft,
  type SchemaDraftEnvelope,
} from "@/lib/schema-draft";
import {
  mergeSchemas,
  type SchemaMergeChoice,
  type SchemaMergeResolutions,
  type SchemaMergeResult,
  unresolvedSchemaConflicts,
} from "@/lib/schema-merge";
import { serializeSchemaFields } from "@/lib/schema-utils";
import { makeId } from "@/lib/utils";
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
  userId: string;
  initialFields: PydanticField[];
  currentVersion: string;
  currentRevision: number;
}

interface SchemaDraftSubmission {
  fields: PydanticField[];
  expectedBaseline: SchemaBaselineIdentity;
}

export interface SchemaDraftConflict {
  draft: SchemaDraftEnvelope;
  remote: SchemaSnapshot;
  merge: SchemaMergeResult;
}

// De onde vieram as alterações que estão na tela. Um booleano "recuperado" não
// dá conta: um rascunho rebasado sobre uma revisão remota nova não foi
// recuperado de lugar nenhum — o usuário nunca fechou a aba — e anunciá-lo como
// "rascunho recuperado" descreve um evento que não aconteceu.
export type DraftOrigin =
  // Editado nesta sessão, do zero.
  | "session"
  // Lido do localStorage no mount (a aba foi fechada ou recarregada antes).
  | "recovered"
  // Rebasado sobre uma revisão remota que chegou durante a edição.
  | "rebased";

interface DraftStorageState {
  available: boolean;
  persistedToken: string | null;
  blocked: boolean;
}

interface CleanState {
  kind: "clean";
  snapshot: SchemaSnapshot;
  origin: DraftOrigin;
  storage: DraftStorageState;
}

interface DirtyState {
  kind: "dirty";
  draft: SchemaDraftEnvelope;
  origin: DraftOrigin;
  storage: DraftStorageState;
}

interface ConflictState {
  kind: "conflict";
  conflict: SchemaDraftConflict;
  origin: DraftOrigin;
  storage: DraftStorageState;
}

type SchemaDraftState = CleanState | DirtyState | ConflictState;

interface StorageRead {
  available: boolean;
  draft: SchemaDraftEnvelope | null;
}

type StorageWrite =
  | { status: "written" }
  | { status: "blocked" }
  | { status: "unavailable" };

interface StorageDelete {
  available: boolean;
  deleted: boolean;
}

// O rascunho pertence a um par usuário+projeto, nunca a um projeto sozinho: o
// localStorage é do navegador, não da sessão, e nada o limpa no logout. Sem o
// usuário na chave, dois coordenadores que dividem a mesma máquina veem o
// rascunho um do outro — e, pior, quem salvar assina no `schema_change_log` uma
// mudança que o outro escreveu, porque `p_changed_by` vem do `getAuthUser()` do
// servidor. Receber o escopo inteiro (em vez de `projectId: string`) é o que
// impede uma chave sem usuário de ser construída.
export interface SchemaDraftScope {
  projectId: string;
  userId: string;
}

export function schemaDraftStorageKey(scope: SchemaDraftScope): string {
  return `${DRAFT_KEY_PREFIX}${scope.userId}:${scope.projectId}`;
}

function sameFields(left: PydanticField[], right: PydanticField[]): boolean {
  return serializeSchemaFields(left) === serializeSchemaFields(right);
}

function stateFields(state: SchemaDraftState): PydanticField[] {
  if (state.kind === "clean") return state.snapshot.fields;
  if (state.kind === "dirty") return state.draft.fields;
  return state.conflict.merge.fields;
}

function stateBaseline(state: SchemaDraftState): SchemaSnapshot {
  if (state.kind === "clean") return state.snapshot;
  if (state.kind === "dirty") return state.draft.base;
  return state.conflict.remote;
}

// `remoteFields` alimenta a conversão v4→v5: um envelope do formato anterior
// (campos sem id) não é descartado — a identidade é reconstruída casando por
// nome com o snapshot remoto, e o envelope convertido é persistido na hora,
// para que o slot volte a ser legível por `writeDraftIfTokenMatches` e pelas
// leituras seguintes sem depender de estado em memória.
function readStoredDraft(
  scope: SchemaDraftScope,
  remoteFields: PydanticField[],
): StorageRead {
  if (typeof window === "undefined") return { available: false, draft: null };
  try {
    const read = readSchemaDraft(
      window.localStorage.getItem(schemaDraftStorageKey(scope)),
    );
    if (read.kind === "draft") return { available: true, draft: read.draft };
    if (read.kind === "convertible") {
      const converted = convertSchemaDraftV4(read.draft, remoteFields);
      window.localStorage.setItem(
        schemaDraftStorageKey(scope),
        JSON.stringify(converted),
      );
      return { available: true, draft: converted };
    }
    return { available: true, draft: null };
  } catch {
    return { available: false, draft: null };
  }
}

// Um envelope de formato que este build já superou é descartável, mas não é
// "não havia nada": o trabalho existia. Fica fora da máquina de estados porque é
// um fato do mount, não uma transição — o `key={userId:projectId}` do
// SchemaEditorSession garante que remontar reavalia.
function readStaleDraftFormat(scope: SchemaDraftScope): number | null {
  if (typeof window === "undefined") return null;
  try {
    const read = readSchemaDraft(
      window.localStorage.getItem(schemaDraftStorageKey(scope)),
    );
    return read.kind === "stale-format" ? read.formatVersion : null;
  } catch {
    return null;
  }
}

function writeDraftIfTokenMatches(
  scope: SchemaDraftScope,
  draft: SchemaDraftEnvelope,
  expectedToken: string | null,
): StorageWrite {
  if (typeof window === "undefined") return { status: "unavailable" };
  try {
    const stored = readSchemaDraft(
      window.localStorage.getItem(schemaDraftStorageKey(scope)),
    );
    // Um envelope que este build não sabe ler pertence a uma aba mais nova, e
    // sobrescrevê-lo apagaria trabalho que não temos como recuperar.
    if (stored.kind === "newer-format") return { status: "blocked" };
    // Um v4 ainda não convertido conta como nosso se o token bater: a conversão
    // preserva o writeToken, então o dono é o mesmo — bloquear aqui travaria a
    // primeira escrita logo após o deploy que bumpou o formato.
    const storedToken =
      stored.kind === "draft" || stored.kind === "convertible"
        ? stored.draft.writeToken
        : null;
    if (storedToken !== expectedToken) {
      return { status: "blocked" };
    }
    window.localStorage.setItem(
      schemaDraftStorageKey(scope),
      JSON.stringify(draft),
    );
    return { status: "written" };
  } catch {
    return { status: "unavailable" };
  }
}

function deleteDraftIfTokenMatches(
  scope: SchemaDraftScope,
  writeToken: string | null,
): StorageDelete {
  if (!writeToken) return { available: true, deleted: false };
  if (typeof window === "undefined") return { available: false, deleted: false };
  try {
    const stored = readSchemaDraft(
      window.localStorage.getItem(schemaDraftStorageKey(scope)),
    );
    const storedToken =
      stored.kind === "draft" || stored.kind === "convertible"
        ? stored.draft.writeToken
        : null;
    if (storedToken !== writeToken) {
      return { available: true, deleted: false };
    }
    window.localStorage.removeItem(schemaDraftStorageKey(scope));
    return { available: true, deleted: true };
  } catch {
    return { available: false, deleted: false };
  }
}

function createDraft(
  fields: PydanticField[],
  base: SchemaSnapshot,
): SchemaDraftEnvelope {
  return {
    formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
    writeToken: makeId("draft"),
    base,
    fields,
  };
}

function dirtyAfterWrite(
  draft: SchemaDraftEnvelope,
  origin: DraftOrigin,
  previousStorage: DraftStorageState,
  write: StorageWrite,
): DirtyState {
  if (write.status === "written") {
    return {
      kind: "dirty",
      draft,
      origin,
      storage: {
        available: true,
        persistedToken: draft.writeToken,
        blocked: false,
      },
    };
  }
  return {
    kind: "dirty",
    draft,
    origin,
    storage: {
      available: write.status !== "unavailable",
      persistedToken: write.status === "blocked"
        ? null
        : previousStorage.persistedToken,
      blocked: write.status === "blocked",
    },
  };
}

function cleanState(
  snapshot: SchemaSnapshot,
  storageAvailable: boolean,
): CleanState {
  return {
    kind: "clean",
    snapshot,
    origin: "session",
    storage: {
      available: storageAvailable,
      persistedToken: null,
      blocked: false,
    },
  };
}

function initialState({
  projectId,
  userId,
  initialFields,
  currentVersion,
  currentRevision,
}: UseSchemaDraftParams): SchemaDraftState {
  const scope: SchemaDraftScope = { projectId, userId };
  const remote: SchemaSnapshot = {
    fields: initialFields,
    version: currentVersion,
    revision: currentRevision,
  };
  const stored = readStoredDraft(scope, remote.fields);
  if (!stored.draft) return cleanState(remote, stored.available);

  const draft = stored.draft;
  const storage: DraftStorageState = {
    available: stored.available,
    persistedToken: draft.writeToken,
    blocked: false,
  };
  // O par da guarda de `stateAfterRemoteChange`, que recusa retroceder a
  // baseline. Aqui o remoto é o render do servidor, e ele pode estar ATRÁS do
  // rascunho: `revalidateSchemaConsumers` não revalida `config/schema`, então
  // uma aba que salvou e voltou a editar pode remontar sobre a revisão anterior.
  // Tratar esse remoto como autoridade rebasaria o rascunho sobre o passado — e
  // pior, o atalho `sameFields`→`clean` logo abaixo compararia contra campos
  // stale e apagaria o rascunho por "coincidir" com o que já não é o remoto.
  if (draft.base.revision > remote.revision) {
    return { kind: "dirty", draft, origin: "recovered", storage };
  }
  if (draft.base.revision === remote.revision) {
    if (sameFields(draft.fields, remote.fields)) {
      const deleted = deleteDraftIfTokenMatches(scope, draft.writeToken);
      return cleanState(remote, deleted.available);
    }
    return {
      kind: "dirty",
      draft,
      origin: "recovered",
      storage,
    };
  }

  const merge = mergeSchemas(draft.base.fields, draft.fields, remote.fields);
  if (unresolvedSchemaConflicts(merge).length > 0) {
    return {
      kind: "conflict",
      conflict: { draft, remote, merge },
      origin: "recovered",
      storage,
    };
  }
  if (sameFields(merge.fields, remote.fields)) {
    const deleted = deleteDraftIfTokenMatches(scope, draft.writeToken);
    return cleanState(remote, deleted.available);
  }
  const rebased = createDraft(merge.fields, remote);
  return dirtyAfterWrite(
    rebased,
    "rebased",
    storage,
    writeDraftIfTokenMatches(scope, rebased, draft.writeToken),
  );
}

function stateAfterFieldsChange(
  current: SchemaDraftState,
  fields: PydanticField[],
  scope: SchemaDraftScope,
): SchemaDraftState {
  if (current.kind === "conflict") return current;
  const baseline = stateBaseline(current);
  if (sameFields(fields, baseline.fields)) {
    const deleted = deleteDraftIfTokenMatches(
      scope,
      current.storage.persistedToken,
    );
    return cleanState(baseline, deleted.available);
  }
  return {
    kind: "dirty",
    draft: createDraft(fields, baseline),
    origin: current.origin,
    storage: current.storage,
  };
}

// O token do slot é sempre `storage.persistedToken` — "o que esta aba gravou por
// último e ainda acredita ser dela" —, nunca o que foi submetido. O debounce
// rotaciona o token a cada tecla, e o editor continua editável durante o save
// (`SchemaBuilderGUI` não recebe `isPending`): qualquer escrita de rascunho entre
// `prepareSubmission()` e aqui deixa o token submetido obsoleto. Apagar por ele
// falhava o compare-and-swap, o envelope ficava órfão, e como este ramo zera
// `persistedToken` toda escrita seguinte passava a colidir com o próprio lixo —
// o rascunho nunca mais era gravado na sessão e o banner culpava outra aba.
function stateAfterSave(
  current: SchemaDraftState,
  saved: SchemaSnapshot,
  scope: SchemaDraftScope,
): SchemaDraftState {
  const fields = stateFields(current);
  if (sameFields(fields, saved.fields)) {
    const deleted = deleteDraftIfTokenMatches(
      scope,
      current.storage.persistedToken,
    );
    return cleanState(saved, deleted.available);
  }
  const draft = createDraft(fields, saved);
  return dirtyAfterWrite(
    draft,
    "session",
    current.storage,
    writeDraftIfTokenMatches(
      scope,
      draft,
      current.storage.persistedToken,
    ),
  );
}

function localChangeForRemoteMerge(state: SchemaDraftState): {
  draft: SchemaDraftEnvelope;
  resolutions: SchemaMergeResolutions;
} {
  if (state.kind === "dirty") return { draft: state.draft, resolutions: {} };
  if (state.kind === "conflict") {
    return {
      draft: state.conflict.draft,
      resolutions: resolutionsFromMerge(state.conflict.merge),
    };
  }
  return {
    draft: createDraft(state.snapshot.fields, state.snapshot),
    resolutions: {},
  };
}

function stateAfterRemoteChange(
  current: SchemaDraftState,
  remote: SchemaSnapshot,
  scope: SchemaDraftScope,
): SchemaDraftState {
  if (remote.revision <= stateBaseline(current).revision) return current;
  const { draft, resolutions } = localChangeForRemoteMerge(current);
  const merge = mergeSchemas(
    draft.base.fields,
    draft.fields,
    remote.fields,
    resolutions,
  );
  if (unresolvedSchemaConflicts(merge).length === 0) {
    if (sameFields(merge.fields, remote.fields)) {
      const deleted = deleteDraftIfTokenMatches(
        scope,
        current.storage.persistedToken,
      );
      return cleanState(remote, deleted.available);
    }
    const rebased = createDraft(merge.fields, remote);
    return dirtyAfterWrite(
      rebased,
      "rebased",
      current.storage,
      writeDraftIfTokenMatches(
        scope,
        rebased,
        current.storage.persistedToken,
      ),
    );
  }
  const stored = readStoredDraft(scope, remote.fields);
  const expectedToken = current.storage.persistedToken;
  const storedToken = stored.draft?.writeToken ?? null;
  const expectedDraftStillStored = storedToken === expectedToken;
  return {
    kind: "conflict",
    conflict: { draft, remote, merge },
    // A proveniência não muda: o merge PAROU aqui, e é o usuário quem vai
    // decidi-lo no diálogo. Anunciar "rebased" fazia o toast dizer "suas
    // alterações foram mescladas" — e o rodapé, "mesclado com a versão mais
    // recente" — exatamente enquanto o diálogo pedia que ele resolvesse as
    // colisões. Quem passa a "rebased" é o ramo sem conflito acima e
    // `stateAfterResolvedDraftApplication`, os dois pontos em que o merge de
    // fato fecha.
    origin: current.origin,
    storage: {
      available: stored.available,
      persistedToken: expectedDraftStillStored ? expectedToken : null,
      blocked:
        stored.available &&
        stored.draft !== null &&
        !expectedDraftStillStored,
    },
  };
}

function resolutionsFromMerge(merge: SchemaMergeResult): SchemaMergeResolutions {
  return Object.fromEntries(
    merge.conflicts.flatMap((conflict) =>
      conflict.resolution ? [[conflict.id, conflict.resolution]] : [],
    ),
  );
}

function stateAfterConflictResolution(
  current: SchemaDraftState,
  conflictId: string,
  choice: SchemaMergeChoice,
): SchemaDraftState {
  if (current.kind !== "conflict") return current;
  if (!current.conflict.merge.conflicts.some(({ id }) => id === conflictId)) {
    return current;
  }
  const resolutions = {
    ...resolutionsFromMerge(current.conflict.merge),
    [conflictId]: choice,
  };
  const merge = mergeSchemas(
    current.conflict.draft.base.fields,
    current.conflict.draft.fields,
    current.conflict.remote.fields,
    resolutions,
  );
  return {
    ...current,
    conflict: { ...current.conflict, merge },
  };
}

// Aplicar um conflito ainda não resolvido devolve o estado intocado: o botão que
// chama isto só existe enquanto há conflito, e é o próprio estado — não um sinal
// de retorno — que diz se algo mudou.
function stateAfterResolvedDraftApplication(
  current: SchemaDraftState,
  scope: SchemaDraftScope,
): SchemaDraftState {
  if (
    current.kind !== "conflict" ||
    unresolvedSchemaConflicts(current.conflict.merge).length > 0
  ) {
    return current;
  }
  const { remote, merge } = current.conflict;
  if (sameFields(merge.fields, remote.fields)) {
    const deleted = deleteDraftIfTokenMatches(
      scope,
      current.storage.persistedToken,
    );
    return cleanState(remote, deleted.available);
  }
  const draft = createDraft(merge.fields, remote);
  return dirtyAfterWrite(
    draft,
    "rebased",
    current.storage,
    writeDraftIfTokenMatches(scope, draft, current.storage.persistedToken),
  );
}

function stateAfterConflictDiscard(
  current: SchemaDraftState,
  scope: SchemaDraftScope,
): SchemaDraftState {
  if (current.kind !== "conflict") return current;
  const deleted = deleteDraftIfTokenMatches(
    scope,
    current.storage.persistedToken,
  );
  return cleanState(current.conflict.remote, deleted.available);
}

function persistedDraft(state: SchemaDraftState): SchemaDraftEnvelope | null {
  if (state.kind === "clean") return null;
  const draft = state.kind === "dirty" ? state.draft : state.conflict.draft;
  return state.storage.persistedToken === draft.writeToken ? draft : null;
}

function pendingDraftWriteToken(state: SchemaDraftState): string | null {
  if (state.kind !== "dirty" || persistedDraft(state)) return null;
  return state.draft.writeToken;
}

function persistDirtyState(
  current: SchemaDraftState,
  scope: SchemaDraftScope,
  writeToken?: string,
): SchemaDraftState {
  if (current.kind !== "dirty" || persistedDraft(current)) return current;
  if (writeToken && current.draft.writeToken !== writeToken) return current;
  return dirtyAfterWrite(
    current.draft,
    current.origin,
    current.storage,
    writeDraftIfTokenMatches(
      scope,
      current.draft,
      current.storage.persistedToken,
    ),
  );
}

function submissionFromState(state: SchemaDraftState): SchemaDraftSubmission {
  if (state.kind === "conflict") {
    throw new Error("Resolva todos os conflitos antes de salvar o schema.");
  }
  return {
    fields: stateFields(state),
    expectedBaseline: { revision: stateBaseline(state).revision },
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
  const { projectId, userId, initialFields, currentVersion, currentRevision } =
    params;
  // Identidade estável: `scope` entra nas deps dos effects abaixo, e um objeto
  // novo a cada render os re-dispararia a cada tecla.
  const scope = useMemo<SchemaDraftScope>(
    () => ({ projectId, userId }),
    [projectId, userId],
  );
  const isHydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const [state, setReactState] = useState<SchemaDraftState>(() => initialState(params));
  // Só o mount decide: depois da primeira escrita o envelope antigo já foi
  // sobrescrito, e reavaliar apagaria o aviso justamente por tê-lo atendido.
  const [staleDraftFormatVersion] = useState(() => readStaleDraftFormat(scope));
  const stateRef = useRef(state);
  const renderedRevisionRef = useRef(currentRevision);

  const setState = useCallback((next: SchemaDraftState) => {
    stateRef.current = next;
    setReactState(next);
  }, []);

  const persistDraft = useCallback(
    (writeToken?: string) => {
      setState(persistDirtyState(stateRef.current, scope, writeToken));
    },
    [scope, setState],
  );

  useEffect(() => {
    if (renderedRevisionRef.current === currentRevision) return;
    renderedRevisionRef.current = currentRevision;
    persistDraft();
    setState(
      stateAfterRemoteChange(
        stateRef.current,
        { fields: initialFields, version: currentVersion, revision: currentRevision },
        scope,
      ),
    );
  }, [currentRevision, currentVersion, initialFields, persistDraft, scope, setState]);

  useEffect(
    () => () => {
      persistDirtyState(stateRef.current, scope);
    },
    [scope],
  );

  const pendingWriteToken = pendingDraftWriteToken(state);

  const setFields = (fields: PydanticField[]) => {
    setState(stateAfterFieldsChange(stateRef.current, fields, scope));
  };

  const prepareSubmission = (): SchemaDraftSubmission => {
    persistDraft();
    return submissionFromState(stateRef.current);
  };

  const markSaved = (saved: SchemaSnapshot) => {
    setState(stateAfterSave(stateRef.current, saved, scope));
  };

  const registerRemoteConflict = (remote: SchemaSnapshot) => {
    persistDraft();
    setState(stateAfterRemoteChange(stateRef.current, remote, scope));
  };

  const resolveConflict = (conflictId: string, choice: SchemaMergeChoice) => {
    setState(stateAfterConflictResolution(stateRef.current, conflictId, choice));
  };

  const applyResolvedDraft = () => {
    setState(stateAfterResolvedDraftApplication(stateRef.current, scope));
  };

  const discardConflictingDraft = () => {
    setState(stateAfterConflictDiscard(stateRef.current, scope));
  };

  const fields = stateFields(state);
  const baseline = stateBaseline(state);
  // `dirty` já significa "difere da baseline": todo ponto que constrói o estado
  // volta `clean` antes quando os campos coincidem — os cinco que passam por
  // `dirtyAfterWrite` por uma guarda `sameFields` direta, e o de rascunho
  // recuperado na mesma revisão porque revisão igual é schema igual (o trigger
  // do banco exige +1 a cada mudança). Recomparar aqui não protegeria de nada:
  // se algum construtor violasse a invariante, isto mascararia o estado
  // inconsistente em vez de deixá-lo aparecer.
  //
  // Em `conflict` o valor é irrelevante por construção, e por isso nem é
  // calculado: todo consumidor testa o conflito ANTES de olhar para `isDirty` —
  // `saveDisabled` (`conflict !== null || !isDirty`), `handlePublishMajor` e
  // `handleBackfill` (`isDirty || conflict`), e `statusMessage`, que sai pelo
  // ramo de `conflictCount` sem chegar a ler o dirty.
  const isDirty = state.kind === "dirty";
  const hasUnsavedWork = isDirty || state.kind === "conflict";
  const draftPersisted = persistedDraft(state) !== null;
  useDraftPersistenceLifecycle(pendingWriteToken, hasUnsavedWork, persistDraft);

  return {
    fields,
    setFields,
    isDirty,
    origin: state.origin,
    savedVersion: baseline.version,
    baseline: { revision: baseline.revision },
    conflict: state.kind === "conflict" ? state.conflict : null,
    storageAvailable: state.storage.available,
    storageBlocked: state.storage.blocked,
    staleDraftDiscarded: staleDraftFormatVersion !== null,
    draftPersisted,
    prepareSubmission,
    markSaved,
    registerRemoteConflict,
    resolveConflict,
    applyResolvedDraft,
    discardConflictingDraft,
    isHydrated,
  };
}
