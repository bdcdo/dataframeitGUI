"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, RotateCcw, MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReviewComment {
  id: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  verdict: string;
  comment: string;
  reviewerName: string;
  resolvedAt: string | null;
  createdAt: string;
}

interface CommentCardProps {
  comment: ReviewComment;
  isPending: boolean;
  onResolve: () => void;
  onReopen: () => void;
  onCreateDiscussion: () => void;
}

function formatVerdictLabel(verdict: string): string {
  if (verdict === "ambiguo") return "Ambíguo";
  if (verdict === "pular") return "Pular";
  if (verdict.startsWith("{")) {
    try {
      const parsed = JSON.parse(verdict) as Record<string, boolean>;
      const selected = Object.entries(parsed)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return selected.length > 0 ? selected.join(", ") : "(nenhuma)";
    } catch {
      /* fallback */
    }
  }
  return verdict;
}

function verdictVariant(
  verdict: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (verdict === "ambiguo") return "secondary";
  if (verdict === "pular") return "outline";
  return "default";
}

export function CommentCard({
  comment,
  isPending,
  onResolve,
  onReopen,
  onCreateDiscussion,
}: CommentCardProps) {
  const isResolved = !!comment.resolvedAt;

  return (
    <Card className={cn(isResolved && "opacity-60")}>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{comment.documentTitle}</p>
            <p className="text-xs text-muted-foreground">
              {comment.fieldDescription || comment.fieldName}
            </p>
          </div>
          <Badge variant={verdictVariant(comment.verdict)} className="shrink-0">
            {formatVerdictLabel(comment.verdict)}
          </Badge>
        </div>

        <blockquote className="border-l-2 pl-3 text-sm text-foreground">
          {comment.comment}
        </blockquote>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {comment.reviewerName} &middot;{" "}
            {new Date(comment.createdAt).toLocaleDateString("pt-BR")}
            {isResolved && (
              <span className="ml-2 text-green-600">
                (resolvido{" "}
                {new Date(comment.resolvedAt!).toLocaleDateString("pt-BR")})
              </span>
            )}
          </p>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={onCreateDiscussion}
              title="Criar discussão"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
            </Button>
            {isResolved ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={onReopen}
                title="Reabrir"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={onResolve}
                title="Resolver"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
