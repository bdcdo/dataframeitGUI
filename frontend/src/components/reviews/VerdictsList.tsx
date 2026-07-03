"use client";

import { useEffect, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronDown,
  ChevronRight,
  Check,
  X,
  MessageSquare,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isAnswerCorrect } from "@/lib/reviews/queries";
import { formatAnswer, formatVerdictDisplay } from "@/lib/reviews/verdict-format";
import { AddNoteButton } from "@/components/shared/AddNoteButton";
import type { VerdictItem } from "@/app/(app)/projects/[id]/reviews/my-verdicts/page";
import type { PydanticField } from "@/lib/types";

export interface DocGroup {
  docId: string;
  title: string;
  items: VerdictItem[];
}

interface VerdictsListProps {
  group: DocGroup;
  fields: PydanticField[];
  fieldFilter: string;
  onFieldFilterChange: (v: string) => void;
  projectId: string;
  userName: string;
  isPending: boolean;
  onAcknowledge: (
    reviewId: string,
    status: "accepted" | "questioned",
    comment?: string,
  ) => Promise<boolean>;
}

export function VerdictsList({
  group,
  fields,
  fieldFilter,
  onFieldFilterChange,
  projectId,
  userName,
  isPending,
  onAcknowledge,
}: VerdictsListProps) {
  const [commentingReviewId, setCommentingReviewId] = useState<string | null>(
    null,
  );
  const [questionComment, setQuestionComment] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll back to top when the displayed document changes.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [group.docId]);

  // Clear the comment input on any successful acknowledgment (mirrors the
  // previous top-level handler), so the open input never lingers after refresh.
  const handleAck = async (
    reviewId: string,
    status: "accepted" | "questioned",
    comment?: string,
  ) => {
    const ok = await onAcknowledge(reviewId, status, comment);
    if (ok) {
      setCommentingReviewId(null);
      setQuestionComment("");
    }
  };

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {group.title}
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          <Select value={fieldFilter} onValueChange={onFieldFilterChange}>
            <SelectTrigger className="w-36 h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-w-[min(24rem,calc(100vw-3rem))]">
              <SelectItem value="all">Todos os campos</SelectItem>
              {fields.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  <div className="flex flex-col items-start gap-0.5">
                    <code className="text-xs font-mono">{f.name}</code>
                    {f.description && f.description !== f.name && (
                      <span className="text-[11px] text-muted-foreground line-clamp-2">
                        {f.description}
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AddNoteButton
            projectId={projectId}
            documentId={group.docId}
            documentTitle={group.title}
            fields={fields}
          />
        </div>
      </div>
      {group.items.map((item) => (
        <VerdictCard
          key={item.reviewId}
          item={item}
          userName={userName}
          isPending={isPending}
          commentingReviewId={commentingReviewId}
          questionComment={questionComment}
          onSetCommentingReviewId={setCommentingReviewId}
          onSetQuestionComment={setQuestionComment}
          onAcknowledge={(reviewId, status, comment) =>
            void handleAck(reviewId, status, comment)
          }
        />
      ))}
    </div>
  );
}

/* ── Verdict Card ── */

function VerdictCard({
  item,
  userName,
  isPending,
  commentingReviewId,
  questionComment,
  onSetCommentingReviewId,
  onSetQuestionComment,
  onAcknowledge,
}: {
  item: VerdictItem;
  userName: string;
  isPending: boolean;
  commentingReviewId: string | null;
  questionComment: string;
  onSetCommentingReviewId: (id: string | null) => void;
  onSetQuestionComment: (v: string) => void;
  onAcknowledge: (
    reviewId: string,
    status: "accepted" | "questioned",
    comment?: string,
  ) => void;
}) {
  const isSpecialVerdict = item.verdict === "ambiguo" || item.verdict === "pular";
  const otherResponses = item.responseSnapshot?.filter(
    (r) => r.respondent_name !== userName,
  );

  return (
    <div
      className={cn(
        "space-y-2.5 rounded-lg border p-4",
        item.isCorrect
          ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/20"
          : "border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20",
      )}
    >
      {/* 1. Field question — prominent */}
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm leading-snug">
          {item.fieldDescription}
        </p>
        {item.isCorrect ? (
          <Badge className="shrink-0 bg-green-500/10 text-green-700 text-xs">
            <Check className="mr-1 size-3" /> Correta
          </Badge>
        ) : (
          <Badge className="shrink-0 bg-red-500/10 text-red-700 text-xs">
            <X className="mr-1 size-3" /> Incorreta
          </Badge>
        )}
      </div>

      {/* 2. Your answer vs Verdict — side by side comparison */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded px-2.5 py-1.5 bg-muted/60">
          <span className="text-[11px] text-muted-foreground">Sua resposta</span>
          <p className={cn(
            "text-sm font-medium mt-0.5",
            !item.isCorrect && !isSpecialVerdict && "text-red-600 dark:text-red-400",
          )}>
            {formatAnswer(item.myAnswer)}
          </p>
        </div>
        <div
          className={cn(
            "rounded px-2.5 py-1.5",
            isSpecialVerdict
              ? "bg-amber-50 dark:bg-amber-950/30"
              : "bg-emerald-50 dark:bg-emerald-950/30",
          )}
        >
          <span className={cn(
            "text-[11px]",
            isSpecialVerdict
              ? "text-amber-600 dark:text-amber-400"
              : "text-emerald-600 dark:text-emerald-400",
          )}>
            Gabarito
          </span>
          <p className={cn(
            "text-sm font-medium mt-0.5",
            isSpecialVerdict
              ? "text-amber-700 dark:text-amber-400"
              : "text-emerald-700 dark:text-emerald-400",
          )}>
            {formatVerdictDisplay(item.verdict, item.fieldType)}
          </p>
        </div>
      </div>

      {/* 3. Coordinator comment — why the verdict */}
      {item.coordinatorComment && (
        <blockquote className="border-l-2 pl-3 text-xs text-muted-foreground italic">
          {item.coordinatorComment}
        </blockquote>
      )}

      {/* 4. Other responses */}
      {otherResponses && otherResponses.length > 0 && (
        <div>
          <p className="text-[11px] text-muted-foreground mb-1">Outras respostas</p>
          <div className="space-y-0.5 rounded-md bg-background/80 p-2">
            {otherResponses.map((r) => (
              <RespondentRow
                key={r.id}
                respondent={r}
                isMe={false}
                isSpecialVerdict={isSpecialVerdict}
                verdict={item.verdict}
                fieldType={item.fieldType}
              />
            ))}
          </div>
        </div>
      )}

      {/* 5. Acknowledgment actions */}
      {(!item.isCorrect || isSpecialVerdict) && (
        <div className="flex items-center gap-2 pt-0.5">
          {(!item.acknowledgmentStatus || item.acknowledgmentStatus === "pending") && (
            <>
              {!item.isCorrect && (
                <Button
                  variant="default"
                  size="sm"
                  className="h-6 text-xs"
                  disabled={isPending}
                  onClick={() => onAcknowledge(item.reviewId, "accepted")}
                >
                  <Check className="mr-1 size-3" />
                  Aceitar correção
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                disabled={isPending}
                onClick={() =>
                  onSetCommentingReviewId(
                    commentingReviewId === item.reviewId ? null : item.reviewId,
                  )
                }
              >
                <MessageSquare className="mr-1 size-3" />
                Comentar dúvida
              </Button>
            </>
          )}
          {item.acknowledgmentStatus === "accepted" && (
            <Badge className="text-xs bg-green-500/10 text-green-700">Aceita</Badge>
          )}
          {item.acknowledgmentStatus === "questioned" && (
            <Badge className="text-xs bg-amber-500/10 text-amber-700">Dúvida enviada</Badge>
          )}
        </div>
      )}

      {/* Comment input */}
      {commentingReviewId === item.reviewId && (
        <div className="flex gap-2">
          <Input
            value={questionComment}
            onChange={(e) => onSetQuestionComment(e.target.value)}
            placeholder="Qual a sua dúvida?"
            className="text-xs h-7"
          />
          <Button
            size="sm"
            className="h-7 text-xs shrink-0"
            disabled={isPending || !questionComment.trim()}
            onClick={() =>
              onAcknowledge(item.reviewId, "questioned", questionComment)
            }
          >
            Enviar
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── Respondent Row ── */

function RespondentRow({
  respondent,
  isMe,
  isSpecialVerdict,
  verdict,
  fieldType,
}: {
  respondent: NonNullable<VerdictItem["responseSnapshot"]>[number];
  isMe: boolean;
  isSpecialVerdict: boolean;
  verdict: string;
  fieldType: VerdictItem["fieldType"];
}) {
  const [showJustification, setShowJustification] = useState(false);
  const correct = isSpecialVerdict || isAnswerCorrect(respondent.answer, verdict, fieldType);

  return (
    <div className="space-y-0.5">
      <div
        className={cn(
          "flex items-center gap-2 rounded px-2 py-1 text-xs",
          isMe && "bg-brand/5 font-medium",
        )}
      >
        {/* Correctness icon */}
        {!isSpecialVerdict && (
          correct ? (
            <Check className="size-3.5 shrink-0 text-emerald-600" />
          ) : (
            <X className="size-3.5 shrink-0 text-red-500" />
          )
        )}

        {/* Answer */}
        <span
          className={cn(
            "min-w-0 truncate",
            !isSpecialVerdict && !correct && "text-red-600 dark:text-red-400",
          )}
        >
          {formatAnswer(respondent.answer) || (
            <span className="italic text-muted-foreground">sem resposta</span>
          )}
        </span>

        {/* Respondent info */}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {respondent.respondent_type === "llm" && (
            <Bot className="size-3" />
          )}
          {isMe ? (
            <>
              <span className="text-brand">★</span>
              <span className="font-medium">Você</span>
            </>
          ) : (
            respondent.respondent_name
          )}
        </span>

        {/* Justification toggle */}
        {respondent.justification && (
          <button
            type="button"
            onClick={() => setShowJustification(!showJustification)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            {showJustification ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Expandable justification */}
      {showJustification && respondent.justification && (
        <blockquote className="ml-6 border-l-2 pl-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {respondent.justification}
        </blockquote>
      )}
    </div>
  );
}
