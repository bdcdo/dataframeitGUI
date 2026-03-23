"use client";

import { ProgressDots } from "../coding/ProgressDots";
import { AgreementGroup } from "./AgreementGroup";
import { VerdictPanel } from "./VerdictPanel";
import { KeyboardHints } from "./KeyboardHints";

interface ComparisonResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answer: unknown;
  justification?: string;
  is_current: boolean;
  isFieldStale: boolean;
}

interface ExistingVerdict {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

interface ComparisonPanelProps {
  fieldName: string;
  fieldDescription: string;
  fieldIndex: number;
  totalFields: number;
  responses: ComparisonResponse[];
  selectedResponseId: string | null;
  onSelectResponse: (id: string) => void;
  existingVerdict: ExistingVerdict | null;
  reviewed: boolean[];
  onFieldNavigate: (index: number) => void;
  onVerdict: (
    verdict: string,
    chosenResponseId?: string,
    comment?: string,
  ) => void;
}

export function ComparisonPanel({
  fieldName,
  fieldDescription,
  fieldIndex,
  totalFields,
  responses,
  selectedResponseId,
  onSelectResponse,
  existingVerdict,
  reviewed,
  onFieldNavigate,
  onVerdict,
}: ComparisonPanelProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-4 py-2">
        <ProgressDots
          total={totalFields}
          currentIndex={fieldIndex}
          answered={reviewed}
          onNavigate={onFieldNavigate}
        />
        <p className="mt-2 text-sm font-medium">
          <span className="text-muted-foreground">
            Campo {fieldIndex + 1}/{totalFields}:
          </span>{" "}
          {fieldDescription || fieldName}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <AgreementGroup
          responses={responses.map((r) => ({
            id: r.id,
            respondent_type: r.respondent_type,
            respondent_name: r.respondent_name,
            answer: r.answer,
            justification: r.justification,
            is_current: r.is_current,
            isFieldStale: r.isFieldStale,
          }))}
          selectedResponseId={selectedResponseId}
          onSelect={onSelectResponse}
          chosenResponseId={existingVerdict?.chosenResponseId ?? null}
        />
      </div>

      <div className="shrink-0 border-t px-4 py-3">
        <VerdictPanel
          responses={responses.map((r) => ({ id: r.id, respondent_name: r.respondent_name }))}
          existingVerdict={existingVerdict}
          onSubmit={onVerdict}
        />
      </div>

      <KeyboardHints responseCount={responses.length} />
    </div>
  );
}
