"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReviewComment } from "./CommentCard";
import {
  TYPE_LABELS,
  TYPE_COLORS,
  formatVerdictLabel,
  verdictVariant,
} from "./comment-card-utils";

interface CommentCardHeaderProps {
  comment: ReviewComment;
  isCoordinator?: boolean;
  onEditField?: () => void;
  onSuggestField?: () => void;
  onOpenDocument?: (documentId: string) => void;
}

export function CommentCardHeader({
  comment,
  isCoordinator,
  onEditField,
  onSuggestField,
  onOpenDocument,
}: CommentCardHeaderProps) {
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {onOpenDocument && comment.documentId ? (
            <button
              type="button"
              onClick={() => onOpenDocument(comment.documentId)}
              className="text-sm font-medium hover:underline text-left"
            >
              {comment.documentTitle}
            </button>
          ) : (
            <span className="text-sm font-medium">{comment.documentTitle || comment.fieldName}</span>
          )}
          <div className="flex items-center gap-1.5">
            <code className="text-xs font-mono text-muted-foreground/70">
              {comment.fieldName}
            </code>
            {isCoordinator && onEditField && comment.source !== "nota" && comment.source !== "exclusao" && (
              <Button
                variant="ghost"
                size="sm"
                className="size-5 p-0"
                onClick={onEditField}
                title="Editar campo"
              >
                <Pencil className="size-3" />
              </Button>
            )}
            {!isCoordinator && onSuggestField && comment.source !== "nota" && comment.source !== "exclusao" && (
              <Button
                variant="ghost"
                size="sm"
                className="size-5 p-0"
                onClick={onSuggestField}
                title="Sugerir alteração"
              >
                <Pencil className="size-3 text-amber-500" />
              </Button>
            )}
          </div>
          {comment.fieldDescription &&
            comment.fieldDescription !== comment.fieldName && (
              <p className="text-xs text-muted-foreground">
                {comment.fieldDescription}
              </p>
            )}
        </div>
        <Badge
          variant={verdictVariant(comment.verdict)}
          className="shrink-0"
        >
          {formatVerdictLabel(comment.verdict)}
        </Badge>
      </div>

      {/* Metadados do campo (contexto para avaliacao do schema) */}
      {(comment.fieldType || comment.fieldHelpText || (comment.fieldOptions && comment.fieldOptions.length > 0)) && (
        <div className="space-y-1 rounded-md bg-muted/30 px-3 py-2">
          {comment.fieldType && (
            <Badge className={cn("text-[10px] px-1 py-0", TYPE_COLORS[comment.fieldType])}>
              {TYPE_LABELS[comment.fieldType]}
            </Badge>
          )}
          {comment.fieldHelpText && (
            <p className="text-xs italic text-muted-foreground">
              {comment.fieldHelpText}
            </p>
          )}
          {comment.fieldOptions && comment.fieldOptions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {comment.fieldOptions.map((opt) => (
                <Badge key={opt} variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                  {opt}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
