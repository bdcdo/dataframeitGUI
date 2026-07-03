"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SuggestionDiff } from "./SuggestionDiff";
import { CommentCardHeader } from "./CommentCardHeader";
import { GabaritoSection } from "./GabaritoSection";
import { SuggestionActions } from "./SuggestionActions";
import { ExclusionActions } from "./ExclusionActions";
import type { ReviewComment } from "./comment-card-utils";

// Tipo vive em comment-card-utils.ts (evita ciclo pai↔filho com os
// componentes extraídos); re-export mantém os consumidores externos intactos.
export type { ReviewComment } from "./comment-card-utils";

interface CommentCardProps {
  comment: ReviewComment;
  projectId: string;
  isPending: boolean;
  isCoordinator?: boolean;
  onResolve: () => void;
  onReopen: () => void;
  onEditField?: () => void;
  onSuggestField?: () => void;
  onOpenDocument?: (documentId: string) => void;
}

export function CommentCard({
  comment,
  projectId,
  isPending,
  isCoordinator,
  onResolve,
  onReopen,
  onEditField,
  onSuggestField,
  onOpenDocument,
}: CommentCardProps) {
  const isResolved = !!comment.resolvedAt;

  return (
    <Card className={cn(isResolved && "opacity-60")}>
      <CardContent className="space-y-2 pt-4">
        <CommentCardHeader
          comment={comment}
          isCoordinator={isCoordinator}
          onEditField={onEditField}
          onSuggestField={onSuggestField}
          onOpenDocument={onOpenDocument}
        />

        <blockquote className="border-l-2 pl-3 text-sm text-foreground">
          {comment.comment}
        </blockquote>

        {comment.source === "sugestao" &&
          comment.suggestionChanges &&
          comment.fieldSnapshot && (
            <SuggestionDiff
              changes={comment.suggestionChanges}
              current={comment.fieldSnapshot}
            />
          )}

        {comment.source === "sugestao" && comment.suggestionId && (
          <SuggestionActions
            suggestionId={comment.suggestionId}
            suggestionStatus={comment.suggestionStatus}
            projectId={projectId}
            isPending={isPending}
            isCoordinator={isCoordinator}
            onResolve={onResolve}
          />
        )}

        {/* Acoes de sugestao de exclusao */}
        {comment.source === "exclusao" && comment.exclusionCommentId && (
          <ExclusionActions
            commentId={comment.exclusionCommentId}
            projectId={projectId}
            status={comment.exclusionStatus ?? "pending"}
            rejectedReason={comment.exclusionRejectedReason}
            isCoordinator={!!isCoordinator}
          />
        )}

        {/* Gabarito expansível (só para reviews, não para notas) */}
        {comment.source !== "nota" &&
          comment.source !== "dificuldade" &&
          comment.source !== "anotacao" &&
          comment.source !== "exclusao" && (
            <GabaritoSection comment={comment} projectId={projectId} />
          )}

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
          <div className="flex gap-1">
            {comment.source === "sugestao" || comment.source === "exclusao"
              ? null
              : isResolved ? (
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
      </CardContent>
    </Card>
  );
}
