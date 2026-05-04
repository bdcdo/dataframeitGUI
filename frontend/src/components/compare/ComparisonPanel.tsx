"use client";

import { useMemo, useState } from "react";
import { ProgressDots } from "../coding/ProgressDots";
import { AgreementGroup, type FieldEquivalencePair } from "./AgreementGroup";
import { MultiOptionReview } from "./MultiOptionReview";
import { KeyboardHints } from "./KeyboardHints";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn, normalizeForComparison } from "@/lib/utils";
import { buildEquivalenceClasses } from "@/lib/equivalence";
import { CheckCircle2, MessageSquare, Lightbulb } from "lucide-react";
import { AddNoteButton } from "@/components/shared/AddNoteButton";
import { SuggestFieldDialog } from "@/components/stats/SuggestFieldDialog";
import type { PydanticField } from "@/lib/types";

function formatVerdictDisplay(verdict: string): string {
  if (verdict.startsWith("{")) {
    try {
      const parsed = JSON.parse(verdict) as Record<string, boolean>;
      const selected = Object.entries(parsed)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return selected.length > 0 ? selected.join(", ") : "(nenhuma)";
    } catch {
      // fallback
    }
  }
  return verdict;
}

interface ComparisonResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answer: unknown;
  justification?: string;
  is_current: boolean;
  isFieldStale: boolean;
  schemaVersion?: string | null;
}

interface ExistingVerdict {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

interface ComparisonPanelProps {
  projectId: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  fieldType?: "single" | "multi" | "text" | "date";
  fieldOptions?: string[] | null;
  fields: PydanticField[];
  fieldIndex: number;
  totalFields: number;
  responses: ComparisonResponse[];
  existingVerdict: ExistingVerdict | null;
  reviewed: boolean[];
  isDivergent: boolean;
  onFieldNavigate: (index: number) => void;
  onVerdict: (verdict: string, chosenResponseId?: string) => void;
  onMarkReviewed: () => void;
  comment: string;
  onCommentChange: (value: string) => void;
  commentCount: number;
  suggestionCount: number;
  allowEquivalence: boolean;
  equivalences: FieldEquivalencePair[];
  onConfirmEquivalent: (
    responseIds: string[],
    gabaritoId: string,
    verdictDisplay: string,
  ) => Promise<void>;
  onUnmarkEquivalencePair: (pairId: string) => Promise<void>;
}

export function ComparisonPanel({
  projectId,
  documentId,
  documentTitle,
  fieldName,
  fieldDescription,
  fieldType,
  fieldOptions,
  fields,
  fieldIndex,
  totalFields,
  responses,
  existingVerdict,
  reviewed,
  isDivergent,
  onFieldNavigate,
  onVerdict,
  onMarkReviewed,
  comment,
  onCommentChange,
  commentCount,
  suggestionCount,
  allowEquivalence,
  equivalences,
  onConfirmEquivalent,
  onUnmarkEquivalencePair,
}: ComparisonPanelProps) {
  const [suggestOpen, setSuggestOpen] = useState(false);

  const isMulti = fieldType === "multi" && fieldOptions && fieldOptions.length > 0;
  const groupCount = useMemo(() => {
    const present = responses.filter((r) => r.answer !== undefined);
    const ids = present.map((r) => r.id);
    const classes = buildEquivalenceClasses(ids, equivalences);
    const inAnyPair = new Set<string>();
    for (const p of equivalences) {
      inAnyPair.add(p.response_a_id);
      inAnyPair.add(p.response_b_id);
    }
    const keys = new Set<string>();
    for (const r of present) {
      const classKey = classes.get(r.id) ?? r.id;
      keys.add(
        inAnyPair.has(r.id)
          ? `eq:${classKey}`
          : `raw:${normalizeForComparison(r.answer)}`,
      );
    }
    return keys.size;
  }, [responses, equivalences]);

  const feedbackBadge = commentCount + suggestionCount;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-4 py-1.5">
        <ProgressDots
          total={totalFields}
          currentIndex={fieldIndex}
          answered={reviewed}
          onNavigate={onFieldNavigate}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-sm font-medium">
            <span className="text-muted-foreground">
              Campo {fieldIndex + 1}/{totalFields}:
            </span>{" "}
            {fieldDescription || fieldName}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {feedbackBadge > 0 && (
              <Badge
                variant="secondary"
                className="h-5 gap-1 px-1.5 text-[10px]"
                title={`${commentCount} nota(s), ${suggestionCount} sugestão(ões) de schema`}
              >
                <MessageSquare className="h-3 w-3" />
                {commentCount}
                {suggestionCount > 0 && (
                  <>
                    <Lightbulb className="ml-1 h-3 w-3" />
                    {suggestionCount}
                  </>
                )}
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2">
        {isMulti ? (
          <MultiOptionReview
            options={fieldOptions}
            responses={responses}
            fieldName={fieldName}
            existingVerdict={existingVerdict}
            onSubmit={(verdictJson) => onVerdict(verdictJson)}
          />
        ) : (
          <AgreementGroup
            key={`${documentId}|${fieldName}`}
            responses={responses.map((r) => ({
              id: r.id,
              respondent_type: r.respondent_type,
              respondent_name: r.respondent_name,
              answer: r.answer,
              justification: r.justification,
              is_current: r.is_current,
              isFieldStale: r.isFieldStale,
              schemaVersion: r.schemaVersion,
            }))}
            existingVerdict={existingVerdict}
            onVote={(displayAnswer, chosenResponseId) =>
              onVerdict(displayAnswer, chosenResponseId)
            }
            allowEquivalence={allowEquivalence}
            equivalences={equivalences}
            onConfirmEquivalent={onConfirmEquivalent}
            onUnmarkPair={onUnmarkEquivalencePair}
          />
        )}

        {isDivergent ? (
          <>
            {!isMulti && (
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
                  [A] Ambiguo
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
            )}

            {existingVerdict && (
              <div className="mt-2 rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
                Veredito anterior:{" "}
                <span className="font-medium text-foreground">
                  {formatVerdictDisplay(existingVerdict.verdict)}
                </span>
                {existingVerdict.comment && (
                  <span className="ml-1">
                    &mdash; &ldquo;{existingVerdict.comment}&rdquo;
                  </span>
                )}
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                placeholder="Comentário (opcional)"
                value={comment}
                onChange={(e) => onCommentChange(e.target.value)}
                className="flex-1 min-w-[180px] text-sm"
              />
              <AddNoteButton
                key={documentId}
                projectId={projectId}
                documentId={documentId}
                documentTitle={documentTitle}
                fieldName={fieldName}
                variant="outline"
                size="sm"
                label="Anotar"
              />
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => setSuggestOpen(true)}
                title="Sugerir alteração ao codebook neste campo"
              >
                <Lightbulb className="h-3.5 w-3.5" />
                Sugerir
              </Button>
            </div>
          </>
        ) : (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-green-500/20 bg-green-500/5 px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              Concordante — todos os respondentes concordam.
            </div>
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onMarkReviewed}>
              Marcar doc como revisado
            </Button>
          </div>
        )}
      </div>

      {isDivergent && (
        <KeyboardHints
          groupCount={groupCount}
          isMulti={!!isMulti}
          optionCount={isMulti ? fieldOptions.length : undefined}
          allowEquivalence={allowEquivalence}
        />
      )}

      <SuggestFieldDialog
        projectId={projectId}
        fieldName={fieldName}
        allFields={fields}
        open={suggestOpen}
        onOpenChange={setSuggestOpen}
      />
    </div>
  );
}
