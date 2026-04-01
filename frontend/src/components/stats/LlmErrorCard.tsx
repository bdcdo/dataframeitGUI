"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  RotateCcw,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface LlmError {
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  llmAnswer: string;
  llmJustification: string | null;
  chosenVerdict: string;
  reviewerComment: string | null;
  resolvedAt: string | null;
}

interface LlmErrorCardProps {
  error: LlmError;
  projectId: string;
  isPending: boolean;
  onResolve: () => void;
  onReopen: () => void;
}

function formatVerdictDisplay(verdict: string): string {
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

export function LlmErrorCard({
  error,
  projectId,
  isPending,
  onResolve,
  onReopen,
}: LlmErrorCardProps) {
  const [showJustification, setShowJustification] = useState(false);

  return (
    <Card className={cn(error.resolvedAt && "opacity-60")}>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{error.documentTitle}</p>
            <p className="text-xs text-muted-foreground">
              {error.fieldDescription || error.fieldName}
            </p>
          </div>
          {error.resolvedAt && (
            <Badge variant="secondary">Resolvido</Badge>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-md bg-red-500/5 px-3 py-2">
            <p className="text-xs font-medium text-red-700">LLM respondeu:</p>
            <p className="text-sm">{error.llmAnswer || "(vazio)"}</p>
          </div>
          <div className="rounded-md bg-green-500/5 px-3 py-2">
            <p className="text-xs font-medium text-green-700">Escolhido:</p>
            <p className="text-sm">
              {formatVerdictDisplay(error.chosenVerdict)}
            </p>
          </div>
        </div>

        {error.llmJustification && (
          <div>
            <button
              onClick={() => setShowJustification(!showJustification)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {showJustification ? (
                <ChevronDown className="inline h-3 w-3" />
              ) : (
                <ChevronRight className="inline h-3 w-3" />
              )}{" "}
              Justificativa do LLM
            </button>
            {showJustification && (
              <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
                {error.llmJustification}
              </p>
            )}
          </div>
        )}

        {error.reviewerComment && (
          <blockquote className="border-l-2 border-amber-500/50 pl-3 text-xs text-muted-foreground">
            <span className="font-medium">Comentário do revisor:</span>{" "}
            {error.reviewerComment}
          </blockquote>
        )}

        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" asChild title="Ver documento">
            <Link href={`/projects/${projectId}/code?doc=${error.documentId}`}>
              <FileText className="h-3.5 w-3.5" />
            </Link>
          </Button>
          {error.resolvedAt ? (
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
      </CardContent>
    </Card>
  );
}
