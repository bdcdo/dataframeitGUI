"use client";

import { Suspense, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { DocumentReader } from "./DocumentReader";
import { QuestionsPanel } from "./QuestionsPanel";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentPicker } from "./DocumentPicker";
import { FullscreenNav } from "./FullscreenNav";
import { saveResponse } from "@/actions/responses";
import { getDocumentsForBrowse, getDocumentForCoding } from "@/actions/documents";
import { applyFieldOrder } from "@/lib/field-order";
import { clearHiddenConditionalAnswers } from "@/lib/conditional";
import { useUrlState } from "@/hooks/useUrlState";
import { useFieldOrder } from "@/hooks/useFieldOrder";
import { useAutosaveOnExit, type AutosavePayload } from "@/hooks/useAutosaveOnExit";
import type { BrowseDocument } from "@/actions/documents";
import type { PydanticField, Document, Assignment, Round, RoundStrategy } from "@/lib/types";
import { CodingHeader } from "./CodingHeader";
import { sortByRecent } from "@/lib/coding-sort";
import { CURRENT_FILTER_VALUE } from "@/lib/rounds";
import { toast } from "sonner";
import { CheckCircle2, FileQuestion, ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  documents: (Document & { assignment?: Pick<Assignment, "id" | "status"> })[];
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
      sortMode === "recent"
        ? sortByRecent(documents, codedAtByDoc)
        : documents,
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

  // Assigned mode state
  const [docIndex, setDocIndex] = useState(initial.docIndex);
  const [allAnswers, setAllAnswers] = useState<Record<string, Record<string, unknown>>>(existingAnswers);
  const [allNotes, setAllNotes] = useState<Record<string, string>>(() => {
    const notes: Record<string, string> = {};
    for (const [docId, justifications] of Object.entries(existingJustifications)) {
      if (typeof justifications?._notes === "string") {
        notes[docId] = justifications._notes;
      }
    }
    return notes;
  });

  // Mode state
  const [mode, setMode] = useState<"assigned" | "browse">(initial.mode);

  // Submit loading state
  const [submitting, setSubmitting] = useState(false);

  // All assigned docs completed
  const [allDone, setAllDone] = useState(false);

  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => setIsFullscreen((prev) => !prev), []);

  // Ordem custom de perguntas do pesquisador (debounce/flush/guard no hook).
  const { fieldOrder, handleReorder } = useFieldOrder(projectId);

  const orderedFields = useMemo(
    () => applyFieldOrder(fields, fieldOrder),
    [fields, fieldOrder],
  );

  // Dirty tracking — marks docs that the user has actually edited
  const [dirtyDocs, setDirtyDocs] = useState<Set<string>>(new Set());
  const markDirty = useCallback((docId: string) => {
    setDirtyDocs((prev) => {
      if (prev.has(docId)) return prev;
      const next = new Set(prev);
      next.add(docId);
      return next;
    });
  }, []);
  const markClean = useCallback((docId: string) => {
    setDirtyDocs((prev) => {
      if (!prev.has(docId)) return prev;
      const next = new Set(prev);
      next.delete(docId);
      return next;
    });
  }, []);

  // Browse mode state
  const [browseDocuments, setBrowseDocuments] = useState<BrowseDocument[] | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [selectedBrowseDoc, setSelectedBrowseDoc] = useState<{
    id: string;
    external_id: string | null;
    title: string | null;
    text: string;
  } | null>(null);
  const [browseAnswers, setBrowseAnswers] = useState<Record<string, unknown>>({});
  const [browseNotes, setBrowseNotes] = useState("");
  const browseFetchedRef = useRef(false);

  // Update URL query param without full navigation
  const updateDocParam = useCallback(
    (docId: string | null) => {
      setParams({ doc: docId }, { scroll: false });
    },
    [setParams]
  );

  // Lazy-load browse documents
  useEffect(() => {
    if (mode === "browse" && !browseFetchedRef.current) {
      browseFetchedRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- inicia o lazy-load dos docs do modo Explorar (sincronização com backend)
      setBrowseLoading(true);
      getDocumentsForBrowse(projectId)
        .then(setBrowseDocuments)
        .finally(() => setBrowseLoading(false));
    }
  }, [mode, projectId]);


  // Fullscreen keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        setIsFullscreen(false);
      }
      if (e.key === "F" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        setIsFullscreen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isFullscreen]);

  // --- Assigned mode handlers ---
  const currentDoc = sortedDocuments[docIndex];
  const docAnswers = useMemo(
    () => allAnswers[currentDoc?.id] || {},
    [allAnswers, currentDoc?.id],
  );
  const docNotes = allNotes[currentDoc?.id] ?? "";

  // --- Auto-save on exit (#14, #28) ---
  // beforeunload + visibilitychange + sendBeacon->fetch keepalive no hook.
  const activeDocId =
    mode === "assigned"
      ? currentDoc?.id ?? null
      : selectedBrowseDoc?.id ?? null;
  const isActiveDocDirty = !!activeDocId && dirtyDocs.has(activeDocId);
  const getAutosavePayload = useCallback((): AutosavePayload | null => {
    if (mode === "assigned") {
      if (!currentDoc) return null;
      return {
        projectId,
        documentId: currentDoc.id,
        answers: docAnswers,
        notes: docNotes,
      };
    }
    if (selectedBrowseDoc) {
      return {
        projectId,
        documentId: selectedBrowseDoc.id,
        answers: browseAnswers,
        notes: browseNotes,
      };
    }
    return null;
  }, [
    mode,
    currentDoc,
    docAnswers,
    docNotes,
    selectedBrowseDoc,
    browseAnswers,
    browseNotes,
    projectId,
  ]);
  useAutosaveOnExit({
    activeDocId,
    isDirty: isActiveDocDirty,
    getPayload: getAutosavePayload,
  });

  const handleAnswer = useCallback(
    (fieldName: string, value: unknown) => {
      const docId = currentDoc?.id;
      if (!docId) return;
      setAllAnswers((prev) => {
        const updated = { ...prev[docId], [fieldName]: value };
        // Ao mudar uma resposta, limpa as condicionais que ficaram órfãs —
        // invariante mantida aqui (no dono do estado) em vez de num useEffect
        // do filho (ver #252).
        return { ...prev, [docId]: clearHiddenConditionalAnswers(fields, updated) };
      });
      markDirty(docId);
    },
    [currentDoc?.id, markDirty, fields]
  );

  const handleNotesChange = useCallback(
    (notes: string) => {
      const docId = currentDoc?.id;
      if (!docId) return;
      setAllNotes((prev) => ({ ...prev, [docId]: notes }));
      markDirty(docId);
    },
    [currentDoc?.id, markDirty]
  );

  const handleSubmit = useCallback(async () => {
    if (!currentDoc || Object.keys(docAnswers).length === 0) return;
    setSubmitting(true);
    const result = await saveResponse(projectId, currentDoc.id, docAnswers, { notes: docNotes });
    setSubmitting(false);
    if (result.success) {
      markClean(currentDoc.id);
      toast.success("Respostas salvas!");
      if (docIndex < sortedDocuments.length - 1) {
        const nextIndex = docIndex + 1;
        setDocIndex(nextIndex);
        // Mantem a URL em sincronia com o doc exibido — sem isso, um refresh
        // apos enviar cai no doc recem-enviado (que no modo "recent" pula para
        // o topo da lista), nao no proximo.
        updateDocParam(sortedDocuments[nextIndex]?.id ?? null);
      } else {
        setAllDone(true);
      }
    } else {
      toast.error(result.error || "Erro ao salvar respostas");
    }
  }, [currentDoc, docAnswers, docNotes, projectId, docIndex, sortedDocuments, updateDocParam, markClean]);

  const handleDocNavigate = useCallback(
    (newIndex: number) => {
      if (currentDoc && dirtyDocs.has(currentDoc.id)) {
        saveResponse(projectId, currentDoc.id, docAnswers, {
          notes: docNotes,
          isAutoSave: true,
        }).then((result) => {
          if (result.success) markClean(currentDoc.id);
          else toast.error(result.error || "Erro ao salvar respostas");
        });
      }
      const clampedIndex = Math.max(0, Math.min(newIndex, sortedDocuments.length - 1));
      setDocIndex(clampedIndex);
      updateDocParam(sortedDocuments[clampedIndex]?.id ?? null);
    },
    [currentDoc, docAnswers, docNotes, projectId, sortedDocuments, updateDocParam, dirtyDocs, markClean]
  );

  // Troca o criterio de ordenacao da navegacao de atribuidos. Ao mudar para
  // "recent", salta direto para o documento codificado mais recentemente — o
  // objetivo da issue #108 e achar em 1 clique o ultimo que o pesquisador
  // mexeu. Ao voltar para "default", mantem o documento atual selecionado.
  const handleSortChange = useCallback(
    (nextSort: CodingSortMode) => {
      if (currentDoc && dirtyDocs.has(currentDoc.id)) {
        saveResponse(projectId, currentDoc.id, docAnswers, {
          notes: docNotes,
          isAutoSave: true,
        }).then((result) => {
          if (result.success) markClean(currentDoc.id);
          else toast.error(result.error || "Erro ao salvar respostas");
        });
      }
      const nextDocs =
        nextSort === "recent"
          ? sortByRecent(documents, codedAtByDoc)
          : documents;
      const targetId =
        nextSort === "recent" ? nextDocs[0]?.id : currentDoc?.id;
      const targetIndex = targetId
        ? nextDocs.findIndex((d) => d.id === targetId)
        : 0;
      setDocIndex(Math.max(0, targetIndex));

      const updates: Record<string, string | null> = {
        sort: nextSort === "default" ? "default" : null,
      };
      if (targetId) updates.doc = targetId;
      setParams(updates, { scroll: false });
    },
    [
      currentDoc,
      docAnswers,
      docNotes,
      projectId,
      documents,
      codedAtByDoc,
      dirtyDocs,
      markClean,
      setParams,
    ]
  );

  // --- Browse mode handlers ---
  const handleBrowseSelect = useCallback(
    async (docId: string) => {
      try {
        const result = await getDocumentForCoding(projectId, docId);
        setSelectedBrowseDoc(result.document);
        setBrowseAnswers(result.existingAnswers ?? {});
        setBrowseNotes(
          typeof result.existingJustifications?._notes === "string"
            ? result.existingJustifications._notes
            : ""
        );
        updateDocParam(docId);
      } catch (e) {
        console.error("Failed to load document:", e);
      }
    },
    [projectId, updateDocParam]
  );

  // Auto-load browse doc from URL param
  const initialBrowseLoadRef = useRef(false);
  useEffect(() => {
    if (
      docParam &&
      mode === "browse" &&
      !initialBrowseLoadRef.current &&
      !selectedBrowseDoc
    ) {
      const assignedIdx = documents.findIndex((d) => d.id === docParam);
      if (assignedIdx < 0) {
        initialBrowseLoadRef.current = true;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- carrega o doc do ?doc= da URL no modo Explorar (sincronização com backend)
        handleBrowseSelect(docParam);
      }
    }
  }, [docParam, mode, documents, selectedBrowseDoc, handleBrowseSelect]);

  const handleBrowseAnswer = useCallback(
    (fieldName: string, value: unknown) => {
      setBrowseAnswers((prev) =>
        clearHiddenConditionalAnswers(fields, { ...prev, [fieldName]: value }),
      );
      if (selectedBrowseDoc) markDirty(selectedBrowseDoc.id);
    },
    [selectedBrowseDoc, markDirty, fields]
  );

  const handleBrowseSubmit = useCallback(async () => {
    if (!selectedBrowseDoc || Object.keys(browseAnswers).length === 0) return;
    setSubmitting(true);
    const result = await saveResponse(projectId, selectedBrowseDoc.id, browseAnswers, { notes: browseNotes });
    setSubmitting(false);
    if (result.success) {
      markClean(selectedBrowseDoc.id);
      toast.success("Respostas salvas!");
      setBrowseDocuments((prev) =>
        prev?.map((d) =>
          d.id === selectedBrowseDoc.id
            ? {
                ...d,
                responseCount: d.userAlreadyResponded
                  ? d.responseCount
                  : d.responseCount + 1,
                userAlreadyResponded: true,
              }
            : d
        ) ?? null
      );
      setSelectedBrowseDoc(null);
      setBrowseAnswers({});
      setBrowseNotes("");
    } else {
      toast.error(result.error || "Erro ao salvar respostas");
    }
  }, [selectedBrowseDoc, browseAnswers, browseNotes, projectId, markClean]);

  const handleBrowseBack = useCallback(() => {
    if (selectedBrowseDoc && dirtyDocs.has(selectedBrowseDoc.id)) {
      saveResponse(projectId, selectedBrowseDoc.id, browseAnswers, {
        notes: browseNotes,
        isAutoSave: true,
      }).then((result) => {
        if (result.success) {
          markClean(selectedBrowseDoc.id);
          setBrowseDocuments((prev) =>
            prev?.map((d) =>
              d.id === selectedBrowseDoc.id
                ? { ...d, userAlreadyResponded: true }
                : d
            ) ?? null
          );
        } else {
          toast.error(result.error || "Erro ao salvar respostas");
        }
      });
    }
    setSelectedBrowseDoc(null);
    setBrowseAnswers({});
    setBrowseNotes("");
    updateDocParam(null);
  }, [selectedBrowseDoc, browseAnswers, browseNotes, projectId, updateDocParam, dirtyDocs, markClean]);

  const handleBrowseRandom = useCallback(() => {
    if (!browseDocuments || browseDocuments.length === 0) return;
    const notResponded = browseDocuments.filter(
      (d) => !d.userAlreadyResponded && d.id !== selectedBrowseDoc?.id
    );
    const pool =
      notResponded.length > 0
        ? notResponded
        : browseDocuments.filter((d) => d.id !== selectedBrowseDoc?.id);
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    handleBrowseSelect(pick.id);
  }, [browseDocuments, selectedBrowseDoc?.id, handleBrowseSelect]);

  // --- Empty states ---
  if (fields.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FileQuestion className="size-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          Schema não definido. Configure os campos em Configurações → Schema.
        </p>
      </div>
    );
  }

  // Get browse doc info for nav
  const browseDocInfo = selectedBrowseDoc
    ? browseDocuments?.find((d) => d.id === selectedBrowseDoc.id)
    : null;

  const assignedTitle = currentDoc?.title || currentDoc?.external_id || "Documento";
  const browseTitle = selectedBrowseDoc?.title || selectedBrowseDoc?.external_id || "Documento";

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const assignedParecerUrl = currentDoc
    ? `${baseUrl}/projects/${projectId}/analyze/code?doc=${currentDoc.id}`
    : undefined;
  const browseParecerUrl = selectedBrowseDoc
    ? `${baseUrl}/projects/${projectId}/analyze/code?doc=${selectedBrowseDoc.id}`
    : undefined;

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex h-[calc(100vh-96px)] flex-col"
      }
    >
      {!isFullscreen && (
        <>
          <CodingHeader
            mode={mode}
            onModeChange={setMode}
            assignedCount={documents.length}
            sortMode={sortMode}
            onSortChange={handleSortChange}
            roundFilter={roundFilter}
            doc={
              mode === "assigned" && currentDoc
                ? {
                    variant: "assigned",
                    title: assignedTitle,
                    index: docIndex,
                    total: documents.length,
                    onNavigate: handleDocNavigate,
                    parecerUrl: assignedParecerUrl,
                    projectId,
                    documentId: currentDoc.id,
                  }
                : mode === "browse" && selectedBrowseDoc
                ? {
                    variant: "browse",
                    title: browseTitle,
                    responseCount: browseDocInfo?.responseCount ?? 0,
                    onBack: handleBrowseBack,
                    onRandom: handleBrowseRandom,
                    parecerUrl: browseParecerUrl,
                    projectId,
                    documentId: selectedBrowseDoc.id,
                  }
                : undefined
            }
            onToggleFullscreen={toggleFullscreen}
          />
        </>
      )}

      {mode === "assigned" && (
        <>
          {allDone ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <CheckCircle2 className="size-16 text-brand" />
              <h2 className="text-xl font-semibold">Parabéns!</h2>
              <p className="text-muted-foreground">
                Você completou todos os {documents.length} documento{documents.length !== 1 ? "s" : ""} atribuído{documents.length !== 1 ? "s" : ""}.
              </p>
              <div className="flex gap-3 mt-2">
                <Button
                  className="bg-brand hover:bg-brand/90 text-brand-foreground"
                  onClick={() => { setMode("browse"); setAllDone(false); }}
                >
                  Explorar mais documentos
                </Button>
              </div>
            </div>
          ) : !currentDoc ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <ClipboardList className="size-10 text-muted-foreground/50" />
              {hasAssignments && roundFilter ? (
                roundFilter.selected === "all" ? (
                  <p className="text-sm text-muted-foreground">
                    Nenhum documento corresponde ao filtro.
                  </p>
                ) : roundFilter.selected === "" || roundFilter.selected === CURRENT_FILTER_VALUE ? (
                  <p className="text-sm text-muted-foreground">
                    Tudo em dia na rodada atual ({roundFilter.currentRoundLabel}).
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Nenhuma resposta sua nessa rodada.
                  </p>
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nenhum documento atribuído. Use a aba Explorar.
                </p>
              )}
            </div>
          ) : (
            <>
              {isFullscreen && (
                <FullscreenNav
                  title={assignedTitle}
                  currentIndex={docIndex}
                  total={documents.length}
                  onNavigate={handleDocNavigate}
                  onExit={toggleFullscreen}
                />
              )}
              <ResizablePanelGroup
                className="flex-1"
              >
                <ResizablePanel defaultSize={55} minSize={25}>
                  <DocumentReader text={currentDoc.text} />
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={45} minSize={25}>
                  <QuestionsPanel
                    key={currentDoc?.id}
                    fields={orderedFields}
                    answers={docAnswers}
                    onAnswer={handleAnswer}
                    onSubmit={handleSubmit}
                    submitting={submitting}
                    notes={docNotes}
                    onNotesChange={handleNotesChange}
                    readOnly={readOnly}
                    onReorder={handleReorder}
                  />
                </ResizablePanel>
              </ResizablePanelGroup>
            </>
          )}
        </>
      )}

      {mode === "browse" && (
        <>
          {browseLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Carregando documentos…
            </div>
          ) : !selectedBrowseDoc ? (
            <DocumentPicker
              documents={browseDocuments ?? []}
              onSelect={handleBrowseSelect}
            />
          ) : (
            <>
              {isFullscreen && (
                <FullscreenNav
                  title={browseTitle}
                  responseCount={browseDocInfo?.responseCount ?? 0}
                  onExit={toggleFullscreen}
                />
              )}
              <ResizablePanelGroup
                className="flex-1"
              >
                <ResizablePanel defaultSize={55} minSize={25}>
                  <DocumentReader text={selectedBrowseDoc.text} />
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={45} minSize={25}>
                  <QuestionsPanel
                    key={selectedBrowseDoc?.id}
                    fields={orderedFields}
                    answers={browseAnswers}
                    onAnswer={handleBrowseAnswer}
                    onSubmit={handleBrowseSubmit}
                    submitting={submitting}
                    notes={browseNotes}
                    onNotesChange={setBrowseNotes}
                    readOnly={readOnly}
                    onReorder={handleReorder}
                  />
                </ResizablePanel>
              </ResizablePanelGroup>
            </>
          )}
        </>
      )}

    </div>
  );
}
