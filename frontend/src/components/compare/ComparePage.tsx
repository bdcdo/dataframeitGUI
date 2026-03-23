"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { DocumentReader } from "../coding/DocumentReader";
import { FullscreenNav } from "../coding/FullscreenNav";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { CompareNav } from "./CompareNav";
import { ComparisonPanel } from "./ComparisonPanel";
import { CreateDiscussionDialog } from "@/components/discussions/CreateDiscussionDialog";
import { submitVerdict } from "@/actions/reviews";
import { toast } from "sonner";
import type { PydanticField } from "@/lib/types";

interface CompareResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answers: Record<string, any>;
  justifications: Record<string, string> | null;
  is_current: boolean;
  pydantic_hash: string | null;
  answer_field_hashes: Record<string, string> | null;
}

interface CompareDocument {
  id: string;
  title: string | null;
  external_id: string | null;
  text: string;
}

interface ExistingVerdictInfo {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

interface ComparePageProps {
  projectId: string;
  documents: CompareDocument[];
  responses: Record<string, CompareResponse[]>;
  divergentFields: Record<string, string[]>;
  fields: PydanticField[];
  existingReviews: Record<string, Record<string, ExistingVerdictInfo>>;
  projectPydanticHash: string | null;
}

export function ComparePage({
  projectId,
  documents,
  responses,
  divergentFields,
  fields,
  existingReviews,
  projectPydanticHash,
}: ComparePageProps) {
  const [docIndex, setDocIndex] = useState(0);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [selectedResponseId, setSelectedResponseId] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [discussDialogOpen, setDiscussDialogOpen] = useState(false);

  // Optimistic local reviews state (merges server data with client-side submissions)
  const [localReviews, setLocalReviews] = useState<
    Record<string, Record<string, ExistingVerdictInfo>>
  >(existingReviews);

  const currentDoc = documents[docIndex];
  const allDocDivergent = currentDoc ? (divergentFields[currentDoc.id] || []) : [];
  const docDivergent = filter === "all"
    ? allDocDivergent
    : allDocDivergent.filter((fn) => fn === filter);
  const currentFieldName = docDivergent[fieldIndex];
  const currentField = fields.find((f) => f.name === currentFieldName);
  const docResponses = currentDoc ? (responses[currentDoc.id] || []) : [];

  const reviewed = docDivergent.map(
    (fn) => !!localReviews[currentDoc?.id]?.[fn]
  );

  // Count docs with all divergent fields reviewed
  const reviewedDocsCount = useMemo(() => {
    return documents.filter((doc) => {
      const docFields = divergentFields[doc.id] || [];
      if (docFields.length === 0) return false;
      return docFields.every((fn) => !!localReviews[doc.id]?.[fn]);
    }).length;
  }, [documents, divergentFields, localReviews]);

  // Current field's existing verdict
  const currentVerdict = currentDoc && currentFieldName
    ? localReviews[currentDoc.id]?.[currentFieldName] ?? null
    : null;

  // Build current field hash lookup
  const currentFieldHashes = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of fields) {
      if (f.hash) map[f.name] = f.hash;
    }
    return map;
  }, [fields]);

  // Prepare responses for current field, computing per-field staleness
  const fieldResponses = docResponses.map((r) => {
    let isFieldStale = false;
    if (r.answer_field_hashes) {
      const savedHash = r.answer_field_hashes[currentFieldName];
      const currentHash = currentFieldHashes[currentFieldName];
      isFieldStale = !savedHash || !currentHash || savedHash !== currentHash;
    } else {
      isFieldStale = !!projectPydanticHash && r.pydantic_hash !== projectPydanticHash;
    }
    return {
      id: r.id,
      respondent_type: r.respondent_type,
      respondent_name: r.respondent_name,
      answer: r.answers[currentFieldName] ?? "",
      justification: r.justifications?.[currentFieldName],
      is_current: r.is_current,
      isFieldStale,
    };
  });

  const handleVerdict = useCallback(
    async (verdict: string, chosenResponseId?: string, comment?: string) => {
      if (!currentDoc || !currentFieldName) return;

      // Optimistic update
      setLocalReviews((prev) => ({
        ...prev,
        [currentDoc.id]: {
          ...prev[currentDoc.id],
          [currentFieldName]: {
            verdict,
            chosenResponseId: chosenResponseId ?? null,
            comment: comment ?? null,
          },
        },
      }));

      // Server call
      await submitVerdict(projectId, currentDoc.id, currentFieldName, verdict, chosenResponseId, comment);

      setSelectedResponseId(null);

      // Check if all fields for this doc are now reviewed
      const allFieldsReviewed = docDivergent.every((fn) => {
        if (fn === currentFieldName) return true; // just submitted
        return !!localReviews[currentDoc.id]?.[fn];
      });

      if (allFieldsReviewed && docIndex < documents.length - 1) {
        toast.success("Todos os campos revisados! Avançando...");
        setTimeout(() => {
          setDocIndex(docIndex + 1);
          setFieldIndex(0);
        }, 1500);
      } else if (fieldIndex < docDivergent.length - 1) {
        setFieldIndex(fieldIndex + 1);
      }
    },
    [projectId, currentDoc, currentFieldName, fieldIndex, docDivergent, docIndex, documents.length, localReviews]
  );

  const handleDocNavigate = useCallback(
    (newIndex: number) => {
      const clamped = Math.max(0, Math.min(newIndex, documents.length - 1));
      setDocIndex(clamped);
      setFieldIndex(0);
    },
    [documents.length]
  );

  const toggleFullscreen = useCallback(() => setIsFullscreen((prev) => !prev), []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Fullscreen toggle
      if (e.key === "F" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        setIsFullscreen((prev) => !prev);
        return;
      }
      if (e.key === "Escape" && isFullscreen) {
        setIsFullscreen(false);
        return;
      }

      // Number keys: select response
      const num = parseInt(e.key);
      if (num >= 1 && num <= docResponses.length) {
        const r = docResponses[num - 1];
        handleVerdict(r.respondent_name, r.id);
        return;
      }

      if (e.key === "a") handleVerdict("ambiguo");
      if (e.key === "s") handleVerdict("pular");
      if (e.key === "n" && fieldIndex < docDivergent.length - 1) setFieldIndex(fieldIndex + 1);
      if (e.key === "p" && fieldIndex > 0) setFieldIndex(fieldIndex - 1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [docResponses, handleVerdict, fieldIndex, docDivergent.length, isFullscreen]);

  if (!currentDoc || docDivergent.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Nenhuma divergência encontrada.
      </div>
    );
  }

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const parecerUrl = `${baseUrl}/projects/${projectId}/code?doc=${currentDoc.id}`;
  const docTitle = currentDoc.title || currentDoc.external_id || "Documento";

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex h-[calc(100vh-88px)] flex-col"
      }
    >
      {isFullscreen ? (
        <FullscreenNav
          title={docTitle}
          currentIndex={docIndex}
          total={documents.length}
          onNavigate={handleDocNavigate}
          onExit={toggleFullscreen}
        />
      ) : (
        <CompareNav
          title={docTitle}
          docIndex={docIndex}
          totalDocs={documents.length}
          onDocNavigate={handleDocNavigate}
          filter={filter}
          onFilterChange={(v) => { setFilter(v); setFieldIndex(0); }}
          fields={fields}
          reviewedDocsCount={reviewedDocsCount}
          onToggleFullscreen={toggleFullscreen}
          onDiscuss={() => setDiscussDialogOpen(true)}
          parecerUrl={parecerUrl}
        />
      )}

      <ResizablePanelGroup className="flex-1">
        <ResizablePanel defaultSize={50} minSize={25}>
          <DocumentReader text={currentDoc.text} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={50} minSize={25}>
          <ComparisonPanel
            fieldName={currentFieldName}
            fieldDescription={currentField?.description || currentFieldName}
            fieldIndex={fieldIndex}
            totalFields={docDivergent.length}
            responses={fieldResponses}
            selectedResponseId={selectedResponseId}
            onSelectResponse={setSelectedResponseId}
            existingVerdict={currentVerdict}
            reviewed={reviewed}
            onFieldNavigate={setFieldIndex}
            onVerdict={handleVerdict}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      <CreateDiscussionDialog
        projectId={projectId}
        documents={documents.map((d) => ({
          id: d.id,
          title: d.title,
          external_id: d.external_id,
        }))}
        defaultDocumentId={currentDoc.id}
        externalOpen={discussDialogOpen}
        onExternalOpenChange={setDiscussDialogOpen}
        onCreated={() => setDiscussDialogOpen(false)}
      />
    </div>
  );
}
