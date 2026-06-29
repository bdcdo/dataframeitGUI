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
import { applyFieldOrder } from "@/lib/field-order";
import { useUrlState } from "@/hooks/useUrlState";
import { useFieldOrder } from "@/hooks/useFieldOrder";
import { useAutosaveOnExit, type AutosavePayload } from "@/hooks/useAutosaveOnExit";
import { useBrowseDocuments } from "@/hooks/useBrowseDocuments";
import { useDocumentForCoding } from "@/hooks/useDocumentForCoding";
import { BrowseDocCoder, type CodingDraft } from "./BrowseDocCoder";
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

/** Estado centralizado de falha + ação de retry do modo Explorar (lista e doc
 *  compartilham a mesma marcação). */
function RetryState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Tentar novamente
      </Button>
    </div>
  );
}

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

  // Browse mode — lista via hook (cache + loading derivado), seleção via URL
  // (?doc=) e conteúdo do doc selecionado via hook. Invariante: nada de estado
  // derivado nem setState em effect aqui (a lista e o doc vivem nos hooks; a
  // seleção é o ?doc=). É o que zera o débito do react-doctor no modo Explorar
  // — em especial o error `react-doctor/no-adjust-state-on-prop-change`.
  const {
    documents: browseDocuments,
    loading: browseLoading,
    error: browseError,
    retry: retryBrowseDocuments,
    markResponded,
  } = useBrowseDocuments(projectId, mode === "browse");
  const browseDocId = useMemo(() => {
    if (mode !== "browse" || !docParam) return null;
    // Só docs não-atribuídos entram no modo Explorar (assigned abre em assigned).
    return documents.some((d) => d.id === docParam) ? null : docParam;
  }, [mode, docParam, documents]);
  const {
    doc: browseDoc,
    loading: browseDocLoading,
    invalidate: invalidateBrowseDoc,
  } = useDocumentForCoding(projectId, browseDocId);
  // Rascunho atual do doc de browse, reportado pelo BrowseDocCoder; lido pelo
  // autosave-on-exit centralizado. Ref (não estado) para não entrar no render.
  const browseDraftRef = useRef<CodingDraft | null>(null);
  // Guarda de reentrância dos saves de browse: impede que um duplo-clique em
  // "Enviar"/"Voltar" dispare saveResponse/markResponded duas vezes antes do
  // setSubmitting re-renderizar e desabilitar os botões.
  const browseSavingRef = useRef(false);

  // Update URL query param without full navigation
  const updateDocParam = useCallback(
    (docId: string | null) => {
      setParams({ doc: docId }, { scroll: false });
    },
    [setParams]
  );

  // Troca de modo (Atribuídos↔Explorar). Ao SAIR do Explorar, descarta o
  // rascunho de browse não salvo: o BrowseDocCoder (keyed) desmonta e, ao voltar,
  // re-semeia do cache pré-edição; sem zerar o draft/dirty do pai aqui, a edição
  // sumiria da tela mas ainda seria salva no autosave-on-exit / "Voltar" (ghost
  // save). Feito em handler (não em effect) para não reintroduzir o débito de
  // react-doctor que o PR zerou.
  const handleModeChange = useCallback(
    (next: "assigned" | "browse") => {
      if (mode === "browse" && next !== "browse" && browseDocId) {
        browseDraftRef.current = null;
        markClean(browseDocId);
      }
      setMode(next);
    },
    [mode, browseDocId, markClean],
  );

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
    mode === "assigned" ? currentDoc?.id ?? null : browseDocId;
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
    if (browseDocId && browseDraftRef.current) {
      return {
        projectId,
        documentId: browseDocId,
        answers: browseDraftRef.current.answers,
        notes: browseDraftRef.current.notes,
      };
    }
    return null;
  }, [mode, currentDoc, docAnswers, docNotes, browseDocId, projectId]);
  useAutosaveOnExit({
    activeDocId,
    isDirty: isActiveDocDirty,
    getPayload: getAutosavePayload,
  });

  const handleAnswer = useCallback(
    (fieldName: string, value: unknown) => {
      const docId = currentDoc?.id;
      if (!docId) return;
      setAllAnswers((prev) => ({
        ...prev,
        [docId]: { ...prev[docId], [fieldName]: value },
      }));
      markDirty(docId);
    },
    [currentDoc?.id, markDirty]
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
  // Seleção = escrever o ?doc= (os hooks buscam a lista e o doc). Trocar de doc
  // descarta o rascunho do anterior — comportamento atual do Explorar — por
  // isso reseta o browseDraftRef e limpa o dirty do doc deixado (senão o id
  // ficaria "sujo" para sempre, disparando o prompt nativo de "alterações não
  // salvas" que nenhum caminho de saída consegue mais persistir).
  const handleBrowseSelect = useCallback(
    (docId: string) => {
      if (browseDocId) markClean(browseDocId);
      browseDraftRef.current = null;
      updateDocParam(docId);
    },
    [browseDocId, markClean, updateDocParam],
  );

  // Reportado pelo BrowseDocCoder a cada edição: alimenta o autosave-on-exit
  // (via ref) e marca o doc como sujo.
  const handleDraftChange = useCallback(
    (draft: CodingDraft) => {
      browseDraftRef.current = draft;
      if (browseDocId) markDirty(browseDocId);
    },
    [browseDocId, markDirty],
  );

  const handleBrowseSubmit = useCallback(
    async ({ answers, notes }: CodingDraft) => {
      if (!browseDocId || Object.keys(answers).length === 0) return;
      if (browseSavingRef.current) return;
      browseSavingRef.current = true;
      setSubmitting(true);
      try {
        const result = await saveResponse(projectId, browseDocId, answers, {
          notes,
        });
        if (result.success) {
          markClean(browseDocId);
          toast.success("Respostas salvas!");
          markResponded(browseDocId, "submit");
          browseDraftRef.current = null;
          // Zera o ?doc= ANTES de invalidar: com browseDocId já null, o hook não
          // refetcha o doc que estamos deixando (evita refetch/flicker). A
          // invalidação garante que reabri-lo na sessão reflita o que foi salvo
          // (sem isto, o seed ficaria stale).
          updateDocParam(null);
          invalidateBrowseDoc(browseDocId);
        } else {
          toast.error(result.error || "Erro ao salvar respostas");
        }
      } finally {
        setSubmitting(false);
        browseSavingRef.current = false;
      }
    },
    [
      browseDocId,
      projectId,
      markClean,
      markResponded,
      invalidateBrowseDoc,
      updateDocParam,
    ],
  );

  const handleBrowseBack = useCallback(async () => {
    const docId = browseDocId;
    let saved = false;
    // Com rascunho sujo, aguarda o autosave ANTES de navegar: se falhar, mantém
    // o doc aberto e o rascunho intacto (em vez de descartá-lo otimisticamente).
    if (docId && dirtyDocs.has(docId) && browseDraftRef.current) {
      if (browseSavingRef.current) return;
      browseSavingRef.current = true;
      const { answers, notes } = browseDraftRef.current;
      setSubmitting(true);
      try {
        const result = await saveResponse(projectId, docId, answers, {
          notes,
          isAutoSave: true,
        });
        if (!result.success) {
          toast.error(
            result.error ||
              "Não foi possível salvar. Suas alterações não foram perdidas.",
          );
          return;
        }
        markClean(docId);
        markResponded(docId, "autosave");
        saved = true;
      } finally {
        setSubmitting(false);
        browseSavingRef.current = false;
      }
    }
    browseDraftRef.current = null;
    // Zera o ?doc= ANTES de invalidar (mesmo motivo do handleBrowseSubmit: evita
    // refetch/flicker do doc que estamos deixando).
    updateDocParam(null);
    if (saved && docId) invalidateBrowseDoc(docId);
  }, [
    browseDocId,
    projectId,
    updateDocParam,
    dirtyDocs,
    markClean,
    markResponded,
    invalidateBrowseDoc,
  ]);

  const handleBrowseRandom = useCallback(() => {
    if (!browseDocuments || browseDocuments.length === 0) return;
    const notResponded = browseDocuments.filter(
      (d) => !d.userAlreadyResponded && d.id !== browseDocId,
    );
    const pool =
      notResponded.length > 0
        ? notResponded
        : browseDocuments.filter((d) => d.id !== browseDocId);
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    handleBrowseSelect(pick.id);
  }, [browseDocuments, browseDocId, handleBrowseSelect]);

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

  // Get browse doc info for nav (metadados vêm da lista; o texto, do hook).
  const browseDocInfo = browseDocId
    ? browseDocuments?.find((d) => d.id === browseDocId)
    : null;

  const assignedTitle = currentDoc?.title || currentDoc?.external_id || "Documento";
  const browseTitle =
    browseDocInfo?.title ||
    browseDocInfo?.external_id ||
    browseDoc?.document.title ||
    browseDoc?.document.external_id ||
    "Documento";

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const assignedParecerUrl = currentDoc
    ? `${baseUrl}/projects/${projectId}/analyze/code?doc=${currentDoc.id}`
    : undefined;
  const browseParecerUrl = browseDocId
    ? `${baseUrl}/projects/${projectId}/analyze/code?doc=${browseDocId}`
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
            onModeChange={handleModeChange}
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
                : mode === "browse" && browseDocId
                ? {
                    variant: "browse",
                    title: browseTitle,
                    responseCount: browseDocInfo?.responseCount ?? 0,
                    onBack: handleBrowseBack,
                    onRandom: handleBrowseRandom,
                    submitting,
                    parecerUrl: browseParecerUrl,
                    projectId,
                    documentId: browseDocId,
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
          {browseError ? (
            <RetryState
              message="Não foi possível carregar os documentos."
              onRetry={retryBrowseDocuments}
            />
          ) : browseLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Carregando documentos…
            </div>
          ) : !browseDocId ? (
            <DocumentPicker
              documents={browseDocuments ?? []}
              onSelect={handleBrowseSelect}
            />
          ) : browseDocLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Carregando documento…
            </div>
          ) : browseDoc ? (
            <BrowseDocCoder
              key={browseDocId}
              doc={browseDoc}
              fields={orderedFields}
              submitting={submitting}
              readOnly={readOnly}
              isFullscreen={isFullscreen}
              title={browseTitle}
              responseCount={browseDocInfo?.responseCount ?? 0}
              onToggleFullscreen={toggleFullscreen}
              onReorder={handleReorder}
              onSubmit={handleBrowseSubmit}
              onDraftChange={handleDraftChange}
            />
          ) : (
            // browseDoc === null → o fetch do doc falhou (erro de transporte ou
            // documento ausente). Oferece retry em vez de afirmar "não encontrado".
            <RetryState
              message="Não foi possível carregar o documento."
              onRetry={() => invalidateBrowseDoc(browseDocId)}
            />
          )}
        </>
      )}

    </div>
  );
}
