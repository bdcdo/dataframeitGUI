"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, RotateCcw, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatVerdictAnswer } from "@/lib/reviews/verdict-format";
import {
  type ReviewComment,
  type ResponseSnapshotEntry,
  TYPE_LABELS,
  TYPE_COLORS,
  formatVerdictLabel,
  verdictVariant,
} from "./comment-card-utils";

interface SplitCommentItemProps {
  comment: ReviewComment;
  isPending: boolean;
  onResolve: () => void;
  onReopen: () => void;
}

export function SplitCommentItem({
  comment,
  isPending,
  onResolve,
  onReopen,
}: SplitCommentItemProps) {
  const isResolved = !!comment.resolvedAt;
  const snapshot = comment.responseSnapshot;

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        isResolved && "opacity-60",
      )}
    >
      {/* Field name + verdict */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <code className="text-xs font-mono text-muted-foreground/70">
            {comment.fieldName}
          </code>
          {comment.fieldType && (
            <Badge
              className={cn(
                "text-[10px] px-1 py-0 shrink-0",
                TYPE_COLORS[comment.fieldType],
              )}
            >
              {TYPE_LABELS[comment.fieldType]}
            </Badge>
          )}
        </div>
        <Badge variant={verdictVariant(comment.verdict)} className="shrink-0 text-xs">
          {formatVerdictLabel(comment.verdict)}
        </Badge>
      </div>

      {/* Descricao + metadados do campo */}
      {comment.fieldDescription && comment.fieldDescription !== comment.fieldName && (
        <p className="text-xs text-muted-foreground">{comment.fieldDescription}</p>
      )}
      {(comment.fieldHelpText ||
        (comment.fieldOptions && comment.fieldOptions.length > 0)) && (
        <div className="space-y-1 rounded-md bg-muted/30 px-2 py-1.5">
          {comment.fieldHelpText && (
            <p className="text-[11px] italic text-muted-foreground">
              {comment.fieldHelpText}
            </p>
          )}
          {comment.fieldOptions && comment.fieldOptions.length > 0 && (
            <div className="flex flex-wrap gap-0.5">
              {comment.fieldOptions.map((opt) => (
                <Badge
                  key={opt}
                  variant="outline"
                  className="text-[10px] px-1 py-0 font-normal"
                >
                  {opt}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Responses (inline, from snapshot) */}
      {snapshot && snapshot.length > 0 && (
        <div className="space-y-0.5 rounded-md bg-muted/50 p-2">
          {snapshot.map((r: ResponseSnapshotEntry) => (
            <div
              key={r.id}
              className={cn(
                "flex items-start gap-2 rounded px-2 py-1 text-xs",
                r.id === comment.chosenResponseId && "bg-brand/5",
              )}
            >
              {r.id === comment.chosenResponseId && (
                <Check className="mt-0.5 size-3 shrink-0 text-brand" />
              )}
              <div className="min-w-0">
                <span className="font-medium">{r.respondent_name}</span>
                <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0">
                  {r.respondent_type === "humano" ? "Humano" : "LLM"}
                </Badge>
                <span className="ml-2 text-muted-foreground">
                  {formatVerdictAnswer(r.answer)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Comment text */}
      <blockquote className="border-l-2 pl-3 text-sm text-foreground">
        {comment.comment}
      </blockquote>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground" suppressHydrationWarning>
          {comment.reviewerName} &middot;{" "}
          {new Date(comment.createdAt).toLocaleDateString("pt-BR")}
          {isResolved && (
            <span className="ml-2 text-green-600">
              (resolvido em{" "}
              {new Date(comment.resolvedAt!).toLocaleDateString("pt-BR")})
            </span>
          )}
        </p>
        {isResolved ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={onReopen}
            title="Reabrir"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={onResolve}
            title="Resolver"
          >
            <CheckCircle2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
