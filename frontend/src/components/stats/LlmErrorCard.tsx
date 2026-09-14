"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RotateCcw, Pencil, FileText, Equal } from "lucide-react";
import { formatDate } from "@/lib/date-format";
import { formatVerdictDisplay } from "@/lib/verdict-display";
import { effectiveErrorResolution, ERROR_DECISION_LABELS, errorDecisionSchema, type ErrorDecision } from "@/lib/error-resolution";
import type { LlmError } from "@/lib/llm-error-metrics";

interface LlmErrorCardProps {
  error: LlmError;
  projectId: string;
  isPending: boolean;
  isCoordinator?: boolean;
  canResolve?: boolean;
  onDecide: (decision: ErrorDecision) => void;
  onReopen: () => void;
  onEditField?: () => void;
  onMarkEquivalent?: () => void;
}

function formatReviewedAt(iso: string): string {
  try { return formatDate(iso); } catch { return iso; }
}

export function LlmErrorCard({ error, projectId, isPending, isCoordinator, canResolve,
  onDecide, onReopen, onEditField, onMarkEquivalent }: LlmErrorCardProps) {
  const status = effectiveErrorResolution(error.resolution).status;
  const label = status === "legacy" ? "Sem decisão registrada"
    : status === "stale" ? "Fontes alteradas: confirme novamente"
    : error.resolution?.decision ? ERROR_DECISION_LABELS[error.resolution.decision] : null;
  return (
    <Card role="article" aria-label={`${error.documentTitle}: ${error.fieldDescription || error.fieldName}`}>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{error.documentTitle}</p>
            <div className="flex items-center gap-1.5">
              <code className="text-xs font-mono text-muted-foreground">{error.fieldName}</code>
              {isCoordinator && onEditField && (
                <Button variant="ghost" size="sm" className="size-5 p-0" onClick={onEditField} title="Editar campo" aria-label="Editar campo">
                  <Pencil className="size-3" />
                </Button>
              )}
            </div>
            {error.fieldDescription && error.fieldDescription !== error.fieldName && (
              <p className="text-xs text-muted-foreground">{error.fieldDescription}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Revisado em {formatReviewedAt(error.reviewedAt)}{error.schemaVersion && ` · schema v${error.schemaVersion}`}
            </p>
          </div>
          {label && <Badge variant="secondary">{label}</Badge>}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-md border px-3 py-2">
            <p className="text-xs font-medium">LLM respondeu:</p>
            <p className="text-sm">{error.llmAnswer || "(vazio)"}</p>
          </div>
          <div className="rounded-md border px-3 py-2">
            <p className="text-xs font-medium">Veredito anterior:</p>
            <p className="text-sm">{formatVerdictDisplay(error.chosenVerdict)}</p>
          </div>
        </div>
        {error.llmJustification && (
          <div className="rounded-md bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium">Justificativa do LLM:</p>
            <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{error.llmJustification}</p>
          </div>
        )}
        {error.reviewerComment && (
          <blockquote className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
            <span className="font-medium">Comentário do revisor:</span> {error.reviewerComment}
          </blockquote>
        )}
        {error.resolution && (
          <p className="text-xs text-muted-foreground">
            Decisão registrada em {formatReviewedAt(error.resolution.resolved_at)}
            {error.resolution.note && ` · ${error.resolution.note}`}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-1">
          <Button variant="ghost" size="sm" asChild title="Ver documento" aria-label="Ver documento">
            <Link href={`/projects/${projectId}/analyze/code?doc=${error.documentId}`}><FileText className="size-3.5" /></Link>
          </Button>
          {/* A equivalência da Comparação não altera o veredito da Auto-revisão (bdcdo/dataframeitGUI#705). */}
          {error.source === "comparacao" && !error.resolution && onMarkEquivalent && error.chosenResponseId && (
            <Button variant="ghost" size="sm" disabled={isPending} onClick={onMarkEquivalent} title="Marcar respostas como equivalentes" aria-label="Marcar respostas como equivalentes">
              <Equal className="size-3.5" />
            </Button>
          )}
          {canResolve && <>
            {errorDecisionSchema.options.map((decision) => (
              <Button key={decision} variant="outline" size="sm" disabled={isPending || !error.sourceId} onClick={() => onDecide(decision)}>
                {ERROR_DECISION_LABELS[decision]}
              </Button>
            ))}
            {error.resolution && (
              <Button variant="ghost" size="sm" disabled={isPending} onClick={onReopen}>
                <RotateCcw className="mr-1 size-3.5" />Reabrir
              </Button>
            )}
          </>}
        </div>
      </CardContent>
    </Card>
  );
}
