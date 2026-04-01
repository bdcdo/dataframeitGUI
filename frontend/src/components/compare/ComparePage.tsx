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
import { submitVerdict, type ResponseSnapshotEntry } from "@/actions/reviews";
import { toast } from "sonner";
import { normalizeForComparison } from "@/lib/utils";
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
  respondentNames: string[];
}

export function ComparePage({
  projectId,
  documents,
  responses,
  divergentFields,
  fields,
  existingReviews,
  projectPydanticHash,
  respondentNames,
}: ComparePageProps) {
  const [docIndex, setDocIndex] = useState(0);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [filter, setFilter] = useState("all");
  const [respondentFilter, setRespondentFilter] = useState("all");
  const [comment, setComment] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showConcordant, setShowConcordant] = useState(false);

  // Optimistic local reviews state (merges server data with client-side submissions)
  const [localReviews, setLocalReviews] = useState<
    Record<string, Record<string, ExistingVerdictInfo>>
  >(existingReviews);

  // All comparable field names (schema order, excluding llm_only/human_only)
  const comparableFieldNames = useMemo(
    () => fields.filter((f) => f.target !== "llm_only" && f.target !== "human_only").map((f) => f.name),
    [fields]
  );

  const currentDoc = documents[docIndex];
  const allDocDivergent = currentDoc ? (divergentFields[currentDoc.id] || []) : [];
  const divergentSet = useMemo(() => new Set(allDocDivergent), [allDocDivergent]);

  // Active field list depends on toggle: all comparable fields (schema order) or only divergent
  const docFieldList = showConcordant ? comparableFieldNames : allDocDivergent;
  const docFields = filter === "all"
    ? docFieldList
    : docFieldList.filter((fn) => fn === filter);
  const currentFieldName = docFields[fieldIndex];
  const currentField = fields.find((f) => f.name === currentFieldName);
  const isCurrentFieldDivergent = divergentSet.has(currentFieldName);
  const allDocResponses = currentDoc ? (responses[currentDoc.id] || []) : [];
  const docResponses = respondentFilter === "all"
    ? allDocResponses
    : allDocResponses.filter((r) => r.respondent_name === respondentFilter);

  // For concordant fields: mark as "reviewed" automatically (no action needed)
  const reviewed = docFields.map((fn) =>
    divergentSet.has(fn) ? !!localReviews[currentDoc?.id]?.[fn] : true
  );
  const concordant = docFields.map((fn) => !divergentSet.has(fn));

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

  // Reset comment when navigating to a different field or document
  useEffect(() => {
    setComment(currentVerdict?.comment || "");
  }, [currentFieldName, currentDoc?.id, currentVerdict?.comment]);

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
      answer: Object.prototype.hasOwnProperty.call(r.answers, currentFieldName)
        ? r.answers[currentFieldName]
        : undefined,
      justification: r.justifications?.[currentFieldName],
      is_current: r.is_current,
      isFieldStale,
    };
  });

  // Group field responses by answer for keyboard shortcuts (excludes undefined answers)
  const answerGroups = useMemo(() => {
    const map = new Map<string, typeof fieldResponses>();
    for (const r of fieldResponses) {
      if (r.answer === undefined) continue;
      const key = normalizeForComparison(r.answer);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return [...map.values()].sort((a, b) => b.length - a.length);
  }, [fieldResponses]);

  const handleVerdict = useCallback(
    async (verdict: string, chosenResponseId?: string) => {
      if (!currentDoc || !currentFieldName || !isCurrentFieldDivergent) return;

      const verdictComment = comment || undefined;

      // Optimistic update
      setLocalReviews((prev) => ({
        ...prev,
        [currentDoc.id]: {
          ...prev[currentDoc.id],
          [currentFieldName]: {
            verdict,
            chosenResponseId: chosenResponseId ?? null,
            comment: verdictComment ?? null,
          },
        },
      }));

      // Build response snapshot from current field responses
      const snapshot: ResponseSnapshotEntry[] = fieldResponses
        .filter((r) => r.answer !== undefined)
        .map((r) => ({
          id: r.id,
          respondent_name: r.respondent_name,
          respondent_type: r.respondent_type,
          answer: r.answer,
          ...(r.justification ? { justification: r.justification } : {}),
        }));

      // Server call
      await submitVerdict(projectId, currentDoc.id, currentFieldName, verdict, chosenResponseId, verdictComment, snapshot);

      setComment("");
      toast.success("Veredito salvo!");

      // Check if all DIVERGENT fields for this doc are now reviewed
      const allFieldsReviewed = allDocDivergent.every((fn) => {
        if (fn === currentFieldName) return true; // just submitted
        return !!localReviews[currentDoc.id]?.[fn];
      });

      if (allFieldsReviewed && docIndex < documents.length - 1) {
        toast.success("Todos os campos revisados! Avançando...");
        setTimeout(() => {
          setDocIndex(docIndex + 1);
          setFieldIndex(0);
        }, 1500);
      } else if (fieldIndex < docFields.length - 1) {
        setFieldIndex(fieldIndex + 1);
      }
    },
    [projectId, currentDoc, currentFieldName, isCurrentFieldDivergent, fieldIndex, docFields, allDocDivergent, docIndex, documents.length, localReviews, comment]
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

      // Navigation always works
      if (e.key === "n" && fieldIndex < docFields.length - 1) { setFieldIndex(fieldIndex + 1); return; }
      if (e.key === "p" && fieldIndex > 0) { setFieldIndex(fieldIndex - 1); return; }

      // Verdict shortcuts only for divergent fields
      if (!isCurrentFieldDivergent) return;

      // Multi-select fields handle their own keyboard shortcuts (number keys + Enter)
      const isMultiField = currentField?.type === "multi" && currentField.options?.length;
      if (isMultiField) {
        if (e.key === "a") handleVerdict("ambiguo");
        if (e.key === "s") handleVerdict("pular");
        return;
      }

      // Number keys: select answer group (single/text fields only)
      const num = parseInt(e.key);
      if (num >= 1 && num <= answerGroups.length) {
        const group = answerGroups[num - 1];
        const answer = group[0].answer;
        const displayAnswer = answer == null ? "" : Array.isArray(answer) ? answer.join(", ") : String(answer);
        handleVerdict(displayAnswer, group[0].id);
        return;
      }

      if (e.key === "a") handleVerdict("ambiguo");
      if (e.key === "s") handleVerdict("pular");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [answerGroups, handleVerdict, fieldIndex, docFields.length, isFullscreen, isCurrentFieldDivergent, currentField]);

  if (!currentDoc || docFields.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {showConcordant
          ? "Nenhum campo comparável encontrado."
          : "Nenhuma divergência encontrada."}
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
          : "flex h-[calc(100vh-96px)] flex-col"
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
          parecerUrl={parecerUrl}
          showConcordant={showConcordant}
          onToggleConcordant={(v) => { setShowConcordant(v); setFieldIndex(0); }}
          respondentFilter={respondentFilter}
          onRespondentFilterChange={setRespondentFilter}
          respondentNames={respondentNames}
          projectId={projectId}
          documentId={currentDoc?.id}
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
            fieldType={currentField?.type}
            fieldOptions={currentField?.options}
            fieldIndex={fieldIndex}
            totalFields={docFields.length}
            responses={fieldResponses}
            existingVerdict={currentVerdict}
            reviewed={reviewed}
            concordant={concordant}
            isDivergent={isCurrentFieldDivergent}
            onFieldNavigate={setFieldIndex}
            onVerdict={handleVerdict}
            comment={comment}
            onCommentChange={setComment}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

    </div>
  );
}
