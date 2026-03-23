"use client";

import { useMemo } from "react";
import { ProgressDots } from "../coding/ProgressDots";
import { AgreementGroup } from "./AgreementGroup";
import { KeyboardHints } from "./KeyboardHints";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
  existingVerdict: ExistingVerdict | null;
  reviewed: boolean[];
  onFieldNavigate: (index: number) => void;
  onVerdict: (
    verdict: string,
    chosenResponseId?: string,
  ) => void;
  comment: string;
  onCommentChange: (value: string) => void;
}

export function ComparisonPanel({
  fieldName,
  fieldDescription,
  fieldIndex,
  totalFields,
  responses,
  existingVerdict,
  reviewed,
  onFieldNavigate,
  onVerdict,
  comment,
  onCommentChange,
}: ComparisonPanelProps) {
  const groupCount = useMemo(() => {
    const keys = new Set(
      responses
        .filter((r) => r.answer !== undefined)
        .map((r) => JSON.stringify(r.answer)),
    );
    return keys.size;
  }, [responses]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-4 py-1.5">
        <ProgressDots
          total={totalFields}
          currentIndex={fieldIndex}
          answered={reviewed}
          onNavigate={onFieldNavigate}
        />
        <p className="mt-1.5 text-sm font-medium">
          <span className="text-muted-foreground">
            Campo {fieldIndex + 1}/{totalFields}:
          </span>{" "}
          {fieldDescription || fieldName}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2">
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
          existingVerdict={existingVerdict}
          onVote={(displayAnswer, chosenResponseId) =>
            onVerdict(displayAnswer, chosenResponseId)
          }
        />

        <div className="mt-2 flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="sm"
            className={cn(
              existingVerdict?.verdict === "ambiguo" &&
                "border-brand bg-brand/10 text-brand",
            )}
            onClick={() => onVerdict("ambiguo")}
          >
            [A] Ambíguo
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              existingVerdict?.verdict === "pular" &&
                "border-brand bg-brand/10 text-brand",
            )}
            onClick={() => onVerdict("pular")}
          >
            [S] Pular
          </Button>
        </div>

        {existingVerdict && (
          <div className="mt-2 rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
            Veredito anterior:{" "}
            <span className="font-medium text-foreground">
              {existingVerdict.verdict}
            </span>
            {existingVerdict.comment && (
              <span className="ml-1">
                &mdash; &ldquo;{existingVerdict.comment}&rdquo;
              </span>
            )}
          </div>
        )}

        <Input
          placeholder="Comentário (opcional)"
          value={comment}
          onChange={(e) => onCommentChange(e.target.value)}
          className="mt-2 text-sm"
        />
      </div>

      <KeyboardHints groupCount={groupCount} />
    </div>
  );
}
