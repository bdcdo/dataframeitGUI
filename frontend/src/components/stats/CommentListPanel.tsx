"use client";

import { Switch } from "@/components/ui/switch";
import { SplitCommentItem } from "./SplitCommentItem";
import type { ReviewComment } from "./comment-card-utils";

interface CommentListPanelProps {
  comments: ReviewComment[];
  showResolved: boolean;
  onShowResolvedChange: (value: boolean) => void;
  isPending: boolean;
  onResolve: (comment: ReviewComment) => void;
  onReopen: (comment: ReviewComment) => void;
}

export function CommentListPanel({
  comments,
  showResolved,
  onShowResolvedChange,
  isPending,
  onResolve,
  onReopen,
}: CommentListPanelProps) {
  const visible = showResolved ? comments : comments.filter((c) => !c.resolvedAt);
  const hidden = comments.length - visible.length;

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          {visible.length} comentário{visible.length !== 1 && "s"}
          {!showResolved && hidden > 0 && (
            <span className="ml-1 text-muted-foreground/60">
              ({hidden} resolvido{hidden !== 1 ? "s" : ""} oculto
              {hidden !== 1 ? "s" : ""})
            </span>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Switch
            checked={showResolved}
            onCheckedChange={onShowResolvedChange}
            className="scale-75"
          />
          <span className="text-xs text-muted-foreground">Mostrar resolvidos</span>
        </div>
      </div>
      {visible.map((comment) => (
        <SplitCommentItem
          key={comment.id}
          comment={comment}
          isPending={isPending}
          onResolve={() => onResolve(comment)}
          onReopen={() => onReopen(comment)}
        />
      ))}
    </div>
  );
}
