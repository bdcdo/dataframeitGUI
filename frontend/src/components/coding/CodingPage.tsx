"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DocumentNav } from "./DocumentNav";
import { DocumentReader } from "./DocumentReader";
import { QuestionsPanel } from "./QuestionsPanel";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentPicker } from "./DocumentPicker";
import { BrowseDocumentNav } from "./BrowseDocumentNav";
import { FullscreenNav } from "./FullscreenNav";
import { saveResponse } from "@/actions/responses";
import { getDocumentsForBrowse, getDocumentForCoding } from "@/actions/documents";
import type { BrowseDocument } from "@/actions/documents";
import type { PydanticField, Document, Assignment } from "@/lib/types";
import { ProgressBanner, type ProgressBannerData } from "./ProgressBanner";
import { CreateDiscussionDialog } from "@/components/discussions/CreateDiscussionDialog";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CodingPageProps {
  projectId: string;
  documents: (Document & { assignment?: Pick<Assignment, "id" | "status"> })[];
  fields: PydanticField[];
  existingAnswers: Record<string, Record<string, any>>;
  hasAssignments?: boolean;
  progress?: ProgressBannerData | null;
}

export function CodingPage({
  projectId,
  documents,
  fields,
  existingAnswers,
  hasAssignments = false,
  progress = null,
}: CodingPageProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const docParam = searchParams.get("doc");

  // Compute initial state from URL param
  const getInitialState = useCallback(() => {
    if (docParam) {
      const assignedIdx = documents.findIndex((d) => d.id === docParam);
      if (assignedIdx >= 0) {
        return { mode: "assigned" as const, docIndex: assignedIdx };
      }
      return { mode: "browse" as const, docIndex: 0 };
    }
    return { mode: (hasAssignments ? "assigned" : "browse") as "assigned" | "browse", docIndex: 0 };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const initial = getInitialState();

  // Assigned mode state
  const [docIndex, setDocIndex] = useState(initial.docIndex);
  const [allAnswers, setAllAnswers] = useState<Record<string, Record<string, any>>>(existingAnswers);

  // Mode state
  const [mode, setMode] = useState<"assigned" | "browse">(initial.mode);

  // Submit loading state
  const [submitting, setSubmitting] = useState(false);

  // All assigned docs completed
  const [allDone, setAllDone] = useState(false);

  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => setIsFullscreen((prev) => !prev), []);

  // Discussion dialog state
  const [discussDocId, setDiscussDocId] = useState<string | undefined>(undefined);
  const [discussDialogOpen, setDiscussDialogOpen] = useState(false);

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
  const [browseAnswers, setBrowseAnswers] = useState<Record<string, any>>({});
  const browseFetchedRef = useRef(false);

  // Update URL query param without full navigation
  const updateDocParam = useCallback(
    (docId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (docId) {
        params.set("doc", docId);
      } else {
        params.delete("doc");
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  // Lazy-load browse documents
  useEffect(() => {
    if (mode === "browse" && !browseFetchedRef.current) {
      browseFetchedRef.current = true;
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
  const currentDoc = documents[docIndex];
  const docAnswers = allAnswers[currentDoc?.id] || {};

  // --- Auto-save on exit (#14) ---
  // Warn on page exit (close tab, navigate away)
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const activeDocId = mode === "assigned" ? currentDoc?.id : selectedBrowseDoc?.id;
      if (activeDocId && dirtyDocs.has(activeDocId)) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [mode, currentDoc?.id, selectedBrowseDoc?.id, dirtyDocs]);

  // Auto-save when tab loses visibility (fallback for close without confirm)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (mode === "assigned" && currentDoc && dirtyDocs.has(currentDoc.id)) {
          saveResponse(projectId, currentDoc.id, docAnswers);
        } else if (mode === "browse" && selectedBrowseDoc && dirtyDocs.has(selectedBrowseDoc.id)) {
          saveResponse(projectId, selectedBrowseDoc.id, browseAnswers);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [mode, currentDoc, docAnswers, selectedBrowseDoc, browseAnswers, projectId, dirtyDocs]);

  const handleAnswer = useCallback(
    (fieldName: string, value: any) => {
      setAllAnswers((prev) => ({
        ...prev,
        [currentDoc.id]: { ...prev[currentDoc.id], [fieldName]: value },
      }));
      markDirty(currentDoc.id);
    },
    [currentDoc?.id, markDirty]
  );

  const handleSubmit = useCallback(async () => {
    if (!currentDoc || Object.keys(docAnswers).length === 0) return;
    setSubmitting(true);
    const result = await saveResponse(projectId, currentDoc.id, docAnswers);
    setSubmitting(false);
    if (result.success) {
      markClean(currentDoc.id);
      toast.success("Respostas salvas!");
      if (docIndex < documents.length - 1) {
        setDocIndex(docIndex + 1);
      } else {
        setAllDone(true);
      }
    } else {
      toast.error(result.error || "Erro ao salvar respostas");
    }
  }, [currentDoc, docAnswers, projectId, docIndex, documents.length, markClean]);

  const handleDocNavigate = useCallback(
    (newIndex: number) => {
      if (currentDoc && dirtyDocs.has(currentDoc.id)) {
        saveResponse(projectId, currentDoc.id, docAnswers).then((result) => {
          if (result.success) markClean(currentDoc.id);
          else toast.error(result.error || "Erro ao salvar respostas");
        });
      }
      const clampedIndex = Math.max(0, Math.min(newIndex, documents.length - 1));
      setDocIndex(clampedIndex);
      updateDocParam(documents[clampedIndex]?.id ?? null);
    },
    [currentDoc, docAnswers, projectId, documents, updateDocParam, dirtyDocs, markClean]
  );

  // --- Browse mode handlers ---
  const handleBrowseSelect = useCallback(
    async (docId: string) => {
      try {
        const result = await getDocumentForCoding(projectId, docId);
        setSelectedBrowseDoc(result.document);
        setBrowseAnswers(
          (result.existingAnswers as Record<string, any>) ?? {}
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
        handleBrowseSelect(docParam);
      }
    }
  }, [docParam, mode, documents, selectedBrowseDoc, handleBrowseSelect]);

  const handleBrowseAnswer = useCallback(
    (fieldName: string, value: any) => {
      setBrowseAnswers((prev) => ({ ...prev, [fieldName]: value }));
      if (selectedBrowseDoc) markDirty(selectedBrowseDoc.id);
    },
    [selectedBrowseDoc, markDirty]
  );

  const handleBrowseSubmit = useCallback(async () => {
    if (!selectedBrowseDoc || Object.keys(browseAnswers).length === 0) return;
    setSubmitting(true);
    const result = await saveResponse(projectId, selectedBrowseDoc.id, browseAnswers);
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
    } else {
      toast.error(result.error || "Erro ao salvar respostas");
    }
  }, [selectedBrowseDoc, browseAnswers, projectId, markClean]);

  const handleBrowseBack = useCallback(() => {
    if (selectedBrowseDoc && dirtyDocs.has(selectedBrowseDoc.id)) {
      saveResponse(projectId, selectedBrowseDoc.id, browseAnswers).then((result) => {
        if (result.success) {
          markClean(selectedBrowseDoc.id);
          setBrowseDocuments((prev) =>
            prev?.map((d) =>
              d.id === selectedBrowseDoc.id
                ? { ...d, userAlreadyResponded: true }
                : d
            ) ?? null
          );
        }
      });
    }
    setSelectedBrowseDoc(null);
    setBrowseAnswers({});
    updateDocParam(null);
  }, [selectedBrowseDoc, browseAnswers, projectId, updateDocParam, dirtyDocs, markClean]);

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
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Schema não definido.
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
    ? `${baseUrl}/projects/${projectId}/code?doc=${currentDoc.id}`
    : undefined;
  const browseParecerUrl = selectedBrowseDoc
    ? `${baseUrl}/projects/${projectId}/code?doc=${selectedBrowseDoc.id}`
    : undefined;

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex h-[calc(100vh-88px)] flex-col"
      }
    >
      {!isFullscreen && (
        <>
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as "assigned" | "browse")}
            className="shrink-0"
          >
            <div className="border-b px-4">
              <TabsList className="h-9">
                <TabsTrigger value="assigned" className="text-xs">
                  Atribuídos ({documents.length})
                </TabsTrigger>
                <TabsTrigger value="browse" className="text-xs">
                  Explorar
                </TabsTrigger>
              </TabsList>
            </div>
          </Tabs>
          {progress && mode === "assigned" && <ProgressBanner data={progress} />}
        </>
      )}

      {mode === "assigned" && (
        <>
          {allDone ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <CheckCircle2 className="h-16 w-16 text-brand" />
              <h2 className="text-xl font-semibold">Parabéns!</h2>
              <p className="text-muted-foreground">
                Você completou todos os {documents.length} documento{documents.length !== 1 ? "s" : ""} atribuído{documents.length !== 1 ? "s" : ""}.
              </p>
              <div className="flex gap-3 mt-2">
                <Button variant="outline" asChild>
                  <a href={`/projects/${projectId}`}>Meu Progresso</a>
                </Button>
                <Button
                  className="bg-brand hover:bg-brand/90 text-brand-foreground"
                  onClick={() => { setMode("browse"); setAllDone(false); }}
                >
                  Explorar mais documentos
                </Button>
              </div>
            </div>
          ) : !currentDoc ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Nenhum documento atribuído. Use a aba Explorar.
            </div>
          ) : (
            <>
              {isFullscreen ? (
                <FullscreenNav
                  title={assignedTitle}
                  currentIndex={docIndex}
                  total={documents.length}
                  onNavigate={handleDocNavigate}
                  onExit={toggleFullscreen}
                />
              ) : (
                <DocumentNav
                  title={assignedTitle}
                  currentIndex={docIndex}
                  total={documents.length}
                  onNavigate={handleDocNavigate}
                  onToggleFullscreen={toggleFullscreen}
                  parecerUrl={assignedParecerUrl}
                  onDiscuss={() => {
                    setDiscussDocId(currentDoc?.id);
                    setDiscussDialogOpen(true);
                  }}
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
                    fields={fields}
                    answers={docAnswers}
                    onAnswer={handleAnswer}
                    onSubmit={handleSubmit}
                    submitting={submitting}
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
              Carregando documentos...
            </div>
          ) : !selectedBrowseDoc ? (
            <DocumentPicker
              documents={browseDocuments ?? []}
              onSelect={handleBrowseSelect}
            />
          ) : (
            <>
              {isFullscreen ? (
                <FullscreenNav
                  title={browseTitle}
                  responseCount={browseDocInfo?.responseCount ?? 0}
                  onExit={toggleFullscreen}
                />
              ) : (
                <BrowseDocumentNav
                  title={browseTitle}
                  responseCount={browseDocInfo?.responseCount ?? 0}
                  onBack={handleBrowseBack}
                  onRandom={handleBrowseRandom}
                  onToggleFullscreen={toggleFullscreen}
                  parecerUrl={browseParecerUrl}
                  onDiscuss={() => {
                    setDiscussDocId(selectedBrowseDoc?.id);
                    setDiscussDialogOpen(true);
                  }}
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
                    fields={fields}
                    answers={browseAnswers}
                    onAnswer={handleBrowseAnswer}
                    onSubmit={handleBrowseSubmit}
                    submitting={submitting}
                  />
                </ResizablePanel>
              </ResizablePanelGroup>
            </>
          )}
        </>
      )}

      {/* Discussion dialog triggered from coding nav */}
      <CreateDiscussionDialog
        projectId={projectId}
        documents={(() => {
          const base = documents.map((d) => ({
            id: d.id,
            title: d.title,
            external_id: d.external_id,
          }));
          if (
            discussDocId &&
            !base.find((d) => d.id === discussDocId) &&
            selectedBrowseDoc
          ) {
            return [
              ...base,
              {
                id: selectedBrowseDoc.id,
                title: selectedBrowseDoc.title,
                external_id: selectedBrowseDoc.external_id ?? null,
              },
            ];
          }
          return base;
        })()}
        defaultDocumentId={discussDocId}
        externalOpen={discussDialogOpen}
        onExternalOpenChange={setDiscussDialogOpen}
        onCreated={() => setDiscussDialogOpen(false)}
      />
    </div>
  );
}
