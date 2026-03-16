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

  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => setIsFullscreen((prev) => !prev), []);

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

  const handleAnswer = useCallback(
    (fieldName: string, value: any) => {
      setAllAnswers((prev) => ({
        ...prev,
        [currentDoc.id]: { ...prev[currentDoc.id], [fieldName]: value },
      }));
    },
    [currentDoc?.id]
  );

  const handleSubmit = useCallback(() => {
    if (currentDoc && Object.keys(docAnswers).length > 0) {
      saveResponse(projectId, currentDoc.id, docAnswers).catch((e) =>
        console.error("Failed to save:", e)
      );
    }
    if (docIndex < documents.length - 1) {
      setDocIndex(docIndex + 1);
    }
  }, [currentDoc, docAnswers, projectId, docIndex, documents.length]);

  const handleDocNavigate = useCallback(
    (newIndex: number) => {
      if (currentDoc && Object.keys(docAnswers).length > 0) {
        saveResponse(projectId, currentDoc.id, docAnswers).catch((e) =>
          console.error("Failed to save:", e)
        );
      }
      const clampedIndex = Math.max(0, Math.min(newIndex, documents.length - 1));
      setDocIndex(clampedIndex);
      updateDocParam(documents[clampedIndex]?.id ?? null);
    },
    [currentDoc, docAnswers, projectId, documents, updateDocParam]
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
    },
    []
  );

  const handleBrowseSubmit = useCallback(() => {
    if (selectedBrowseDoc && Object.keys(browseAnswers).length > 0) {
      saveResponse(projectId, selectedBrowseDoc.id, browseAnswers).catch((e) =>
        console.error("Failed to save:", e)
      );
    }
    setBrowseDocuments((prev) =>
      prev?.map((d) =>
        d.id === selectedBrowseDoc?.id
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
  }, [selectedBrowseDoc, browseAnswers, projectId]);

  const handleBrowseBack = useCallback(() => {
    if (selectedBrowseDoc && Object.keys(browseAnswers).length > 0) {
      saveResponse(projectId, selectedBrowseDoc.id, browseAnswers)
        .then(() => {
          setBrowseDocuments((prev) =>
            prev?.map((d) =>
              d.id === selectedBrowseDoc.id
                ? { ...d, userAlreadyResponded: true }
                : d
            ) ?? null
          );
        })
        .catch((e) => console.error("Failed to save:", e));
    }
    setSelectedBrowseDoc(null);
    setBrowseAnswers({});
    updateDocParam(null);
  }, [selectedBrowseDoc, browseAnswers, projectId, updateDocParam]);

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
          {!currentDoc ? (
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
