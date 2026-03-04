"use client";

import { useState, useEffect, useCallback } from "react";
import { DocumentReader } from "../coding/DocumentReader";
import { DocumentNav } from "../coding/DocumentNav";
import { ProgressDots } from "../coding/ProgressDots";
import { ResponseCard } from "./ResponseCard";
import { VerdictPanel } from "./VerdictPanel";
import { CompareFilter } from "./CompareFilter";
import { submitVerdict } from "@/actions/reviews";
import type { PydanticField } from "@/lib/types";

interface CompareResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answers: Record<string, any>;
  justifications: Record<string, string> | null;
  is_current: boolean;
}

interface CompareDocument {
  id: string;
  title: string | null;
  external_id: string | null;
  text: string;
}

interface ComparePageProps {
  projectId: string;
  documents: CompareDocument[];
  responses: Record<string, CompareResponse[]>;
  divergentFields: Record<string, string[]>;
  fields: PydanticField[];
  existingReviews: Record<string, Record<string, string>>;
}

export function ComparePage({ projectId, documents, responses, divergentFields, fields, existingReviews }: ComparePageProps) {
  const [docIndex, setDocIndex] = useState(0);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [selectedResponseId, setSelectedResponseId] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");

  const currentDoc = documents[docIndex];
  const allDocDivergent = currentDoc ? (divergentFields[currentDoc.id] || []) : [];
  const docDivergent = filter === "all"
    ? allDocDivergent
    : allDocDivergent.filter((fn) => fn === filter);
  const currentFieldName = docDivergent[fieldIndex];
  const currentField = fields.find((f) => f.name === currentFieldName);
  const docResponses = currentDoc ? (responses[currentDoc.id] || []) : [];

  const reviewed = docDivergent.map((fn) => !!existingReviews[currentDoc?.id]?.[fn]);

  const handleVerdict = useCallback(async (verdict: string, chosenResponseId?: string, comment?: string) => {
    if (!currentDoc || !currentFieldName) return;
    await submitVerdict(projectId, currentDoc.id, currentFieldName, verdict, chosenResponseId, comment);
    if (fieldIndex < docDivergent.length - 1) {
      setFieldIndex(fieldIndex + 1);
    }
    setSelectedResponseId(null);
  }, [projectId, currentDoc, currentFieldName, fieldIndex, docDivergent.length]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
  }, [docResponses, handleVerdict, fieldIndex, docDivergent.length]);

  if (!currentDoc || docDivergent.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Nenhuma divergência encontrada.
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-88px)] flex-col">
      <div className="flex items-center justify-between border-b px-4 py-1">
        <DocumentNav
          title={currentDoc.title || currentDoc.external_id || "Documento"}
          currentIndex={docIndex}
          total={documents.length}
          onNavigate={(i) => { setDocIndex(i); setFieldIndex(0); }}
        />
        <CompareFilter value={filter} onChange={(v) => { setFilter(v); setFieldIndex(0); }} fields={fields} />
      </div>
      <DocumentReader text={currentDoc.text} />
      <div className="border-t bg-card">
        <ProgressDots total={docDivergent.length} currentIndex={fieldIndex} answered={reviewed} onNavigate={setFieldIndex} />
        <div className="max-h-[40vh] overflow-y-auto px-4 pb-4">
          <p className="mb-3 text-sm font-medium">
            <span className="text-muted-foreground">Campo {fieldIndex + 1}/{docDivergent.length}:</span>{" "}
            {currentField?.description || currentFieldName}
          </p>
          <div className="space-y-2">
            {docResponses.map((r, i) => (
              <ResponseCard
                key={r.id}
                response={{
                  ...r,
                  answer: r.answers[currentFieldName] ?? "",
                  justification: r.justifications?.[currentFieldName],
                }}
                index={i}
                isSelected={selectedResponseId === r.id}
                onSelect={() => setSelectedResponseId(r.id)}
              />
            ))}
          </div>
          <div className="mt-3">
            <VerdictPanel
              responses={docResponses.map((r) => ({ id: r.id, respondent_name: r.respondent_name || "?" }))}
              onSubmit={handleVerdict}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
