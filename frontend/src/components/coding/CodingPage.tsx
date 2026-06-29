"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { applyFieldOrder } from "@/lib/field-order";
import { sortByRecent } from "@/lib/coding-sort";
import { useUrlState } from "@/hooks/useUrlState";
import { useFieldOrder } from "@/hooks/useFieldOrder";
import { useAutosaveOnExit } from "@/hooks/useAutosaveOnExit";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useDirtyDocs } from "@/hooks/useDirtyDocs";
import { CodingHeader } from "./CodingHeader";
import { CodingEmptyStates } from "./CodingEmptyStates";
import { AssignedCodingView } from "./AssignedCodingView";
import { BrowseCodingView } from "./BrowseCodingView";
import { useAssignedCoding } from "./useAssignedCoding";
import { useBrowseCoding } from "./useBrowseCoding";
import type {
  PydanticField,
  AssignedDoc,
  Round,
  RoundStrategy,
} from "@/lib/types";

export interface RoundFilterData {
  strategy: RoundStrategy;
  currentRoundKey: string;
  currentRoundLabel: string;
  rounds: Round[];
  previousVersions: string[];
  selected: string;
}

export type CodingSortMode = "default" | "recent";

const EMPTY_CODED_AT: Record<string, string> = {};
const EMPTY_JUSTIFICATIONS: Record<string, Record<string, unknown>> = {};

interface CodingPageProps {
  projectId: string;
  documents: AssignedDoc[];
  codedAtByDoc?: Record<string, string>;
  fields: PydanticField[];
  existingAnswers: Record<string, Record<string, unknown>>;
  existingJustifications?: Record<string, Record<string, unknown>>;
  hasAssignments?: boolean;
  readOnly?: boolean;
  roundFilter?: RoundFilterData;
}

export function CodingPage(props: CodingPageProps) {
  // useSearchParams precisa de boundary de Suspense (react-doctor
  // nextjs-no-use-search-params-without-suspense).
  return (
    <Suspense fallback={null}>
      <CodingPageInner {...props} />
    </Suspense>
  );
}

function CodingPageInner({
  projectId,
  documents,
  codedAtByDoc = EMPTY_CODED_AT,
  fields,
  existingAnswers,
  existingJustifications = EMPTY_JUSTIFICATIONS,
  hasAssignments = false,
  readOnly = false,
  roundFilter,
}: CodingPageProps) {
  const { get: getParam, set: setParams } = useUrlState();
  const docParam = getParam("doc");

  // Ordenacao da navegacao de documentos atribuidos (issue #108). Padrao e
  // "recent" — ordena pelo responses.updated_at do proprio pesquisador, para o
  // pesquisador cair direto no ultimo documento que mexeu. "default" (opt-in
  // via ?sort=default) mantem a ordem do servidor (status do assignment).
  const sortMode: CodingSortMode =
    getParam("sort") === "default" ? "default" : "recent";
  const sortedDocuments = useMemo(
    () =>
      sortMode === "recent" ? sortByRecent(documents, codedAtByDoc) : documents,
    [documents, sortMode, codedAtByDoc],
  );

  // Estado inicial derivado do ?doc= da URL. O lazy initializer do useState
  // roda só no mount, capturando docParam/sortedDocuments/hasAssignments
  // iniciais — intencional: navegação posterior não deve recomputar o estado
  // inicial (era um useCallback com deps [] + eslint-disable).
  const [initial] = useState(() => {
    if (docParam) {
      const assignedIdx = sortedDocuments.findIndex((d) => d.id === docParam);
      if (assignedIdx >= 0) {
        return { mode: "assigned" as const, docIndex: assignedIdx };
      }
      return { mode: "browse" as const, docIndex: 0 };
    }
    return {
      mode: (hasAssignments ? "assigned" : "browse") as "assigned" | "browse",
      docIndex: 0,
    };
  });

  const [mode, setMode] = useState<"assigned" | "browse">(initial.mode);
  const [submitting, setSubmitting] = useState(false);

  const { isFullscreen, toggleFullscreen } = useFullscreen();

  // Ordem custom de perguntas do pesquisador (debounce/flush/guard no hook).
  const { fieldOrder, handleReorder } = useFieldOrder(projectId);
  const orderedFields = useMemo(
    () => applyFieldOrder(fields, fieldOrder),
    [fields, fieldOrder],
  );

  // Dirty tracking via ref (sem re-render) — compartilhado entre os modos.
  const { markDirty, markClean, isDirty } = useDirtyDocs();

  const updateDocParam = useCallback(
    (docId: string | null) => {
      setParams({ doc: docId }, { scroll: false });
    },
    [setParams],
  );

  const assigned = useAssignedCoding({
    projectId,
    documents,
    fields,
    sortedDocuments,
    codedAtByDoc,
    existingAnswers,
    existingJustifications,
    initialDocIndex: initial.docIndex,
    setSubmitting,
    markDirty,
    markClean,
    isDirty,
    updateDocParam,
    setParams,
  });

  const browse = useBrowseCoding({
    projectId,
    documents,
    mode,
    docParam,
    setSubmitting,
    markDirty,
    markClean,
    isDirty,
    updateDocParam,
  });

  // Troca de modo (Atribuídos↔Explorar). Ao SAIR do Explorar, descarta o
  // rascunho de browse não salvo: o BrowseDocCoder (keyed) desmonta e, ao voltar,
  // re-semeia do cache pré-edição; sem zerar o draft/dirty aqui, a edição sumiria
  // da tela mas ainda seria salva no autosave-on-exit / "Voltar" (ghost save).
  const discardBrowseDraft = browse.discardDraft;
  const handleModeChange = useCallback(
    (next: "assigned" | "browse") => {
      if (mode === "browse" && next !== "browse") discardBrowseDraft();
      setMode(next);
    },
    [mode, discardBrowseDraft],
  );

  // --- Auto-save on exit (#14, #28) ---
  // Instância única; o payload e a sujeira saem do modo ativo. `getIsDirty` é
  // um getter (lido no unload) para não acessar o ref do dirty no render.
  const activeDocId =
    mode === "assigned" ? assigned.currentDoc?.id ?? null : browse.browseDocId;
  const getIsDirty = useCallback(
    () => isDirty(activeDocId),
    [isDirty, activeDocId],
  );
  const getAssignedPayload = assigned.getPayload;
  const getBrowsePayload = browse.getPayload;
  const getPayload = useCallback(
    () => (mode === "assigned" ? getAssignedPayload() : getBrowsePayload()),
    [mode, getAssignedPayload, getBrowsePayload],
  );
  useAutosaveOnExit({ activeDocId, getIsDirty, getPayload });

  if (fields.length === 0) {
    return <CodingEmptyStates kind="no-fields" />;
  }

  const assignedTitle =
    assigned.currentDoc?.title || assigned.currentDoc?.external_id || "Documento";
  const browseTitle =
    browse.browseDocInfo?.title ||
    browse.browseDocInfo?.external_id ||
    browse.browseDoc?.document.title ||
    browse.browseDoc?.document.external_id ||
    "Documento";

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const assignedParecerUrl = assigned.currentDoc
    ? `${baseUrl}/projects/${projectId}/analyze/code?doc=${assigned.currentDoc.id}`
    : undefined;
  const browseParecerUrl = browse.browseDocId
    ? `${baseUrl}/projects/${projectId}/analyze/code?doc=${browse.browseDocId}`
    : undefined;

  const handleExploreMore = () => {
    setMode("browse");
    assigned.resetAllDone();
  };

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex h-[calc(100vh-96px)] flex-col"
      }
    >
      {!isFullscreen && (
        <CodingHeader
          mode={mode}
          onModeChange={handleModeChange}
          assignedCount={documents.length}
          sortMode={sortMode}
          onSortChange={assigned.handleSortChange}
          roundFilter={roundFilter}
          doc={
            mode === "assigned" && assigned.currentDoc
              ? {
                  variant: "assigned",
                  title: assignedTitle,
                  index: assigned.docIndex,
                  total: documents.length,
                  onNavigate: assigned.handleDocNavigate,
                  parecerUrl: assignedParecerUrl,
                  projectId,
                  documentId: assigned.currentDoc.id,
                }
              : mode === "browse" && browse.browseDocId
              ? {
                  variant: "browse",
                  title: browseTitle,
                  responseCount: browse.browseDocInfo?.responseCount ?? 0,
                  onBack: browse.handleBrowseBack,
                  onRandom: browse.handleBrowseRandom,
                  submitting,
                  parecerUrl: browseParecerUrl,
                  projectId,
                  documentId: browse.browseDocId,
                }
              : undefined
          }
          onToggleFullscreen={toggleFullscreen}
        />
      )}

      {mode === "assigned" &&
        (assigned.allDone ? (
          <CodingEmptyStates
            kind="all-done"
            count={documents.length}
            onExploreMore={handleExploreMore}
          />
        ) : !assigned.currentDoc ? (
          <CodingEmptyStates
            kind="no-doc"
            hasAssignments={hasAssignments}
            roundFilter={roundFilter}
          />
        ) : (
          <AssignedCodingView
            docId={assigned.currentDoc.id}
            text={assigned.currentDoc.text}
            title={assignedTitle}
            docIndex={assigned.docIndex}
            total={documents.length}
            isFullscreen={isFullscreen}
            onNavigate={assigned.handleDocNavigate}
            onExitFullscreen={toggleFullscreen}
            fields={orderedFields}
            answers={assigned.docAnswers}
            onAnswer={assigned.handleAnswer}
            onSubmit={assigned.handleSubmit}
            submitting={submitting}
            notes={assigned.docNotes}
            onNotesChange={assigned.handleNotesChange}
            readOnly={readOnly}
            onReorder={handleReorder}
          />
        ))}

      {mode === "browse" && (
        <BrowseCodingView
          browseLoading={browse.browseLoading}
          browseError={browse.browseError}
          browseDocId={browse.browseDocId}
          browseDocuments={browse.browseDocuments}
          browseDocLoading={browse.browseDocLoading}
          browseDoc={browse.browseDoc}
          onSelect={browse.handleBrowseSelect}
          onRetry={browse.retryBrowse}
          onRetryDoc={browse.retryBrowseDoc}
          fields={orderedFields}
          submitting={submitting}
          readOnly={readOnly}
          isFullscreen={isFullscreen}
          title={browseTitle}
          responseCount={browse.browseDocInfo?.responseCount ?? 0}
          onToggleFullscreen={toggleFullscreen}
          onReorder={handleReorder}
          onSubmit={browse.handleBrowseSubmit}
          onDraftChange={browse.handleDraftChange}
        />
      )}
    </div>
  );
}
