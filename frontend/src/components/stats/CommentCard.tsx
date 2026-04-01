"use client";

import { useState, useTransition } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  CheckCircle2,
  RotateCcw,
  ChevronDown,
  Pencil,
  Loader2,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchGabaritoForComment,
  type GabaritoRespondentAnswer,
} from "@/actions/stats";

export interface ReviewComment {
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
  chosenResponseId: string | null;
  source: "review" | "nota";
}

interface CommentCardProps {
  comment: ReviewComment;
  projectId: string;
  isPending: boolean;
  isCoordinator?: boolean;
  onResolve: () => void;
  onReopen: () => void;
  onEditField?: () => void;
}

function formatVerdictLabel(verdict: string): string {
  if (verdict === "nota") return "Nota do pesquisador";
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
  if (verdict === "nota") return "secondary";
  if (verdict === "ambiguo") return "secondary";
  if (verdict === "pular") return "outline";
  return "default";
}

function formatAnswer(answer: unknown): string {
  if (answer === null || answer === undefined) return "(sem resposta)";
  if (Array.isArray(answer)) return answer.join(", ");
  return String(answer);
}

export function CommentCard({
  comment,
  projectId,
  isPending,
  isCoordinator,
  onResolve,
  onReopen,
  onEditField,
}: CommentCardProps) {
  const isResolved = !!comment.resolvedAt;
  const [gabaritoOpen, setGabaritoOpen] = useState(false);
  const [gabaritoData, setGabaritoData] = useState<
    GabaritoRespondentAnswer[] | null
  >(null);
  const [loadingGabarito, startLoadGabarito] = useTransition();

  const handleGabaritoToggle = (open: boolean) => {
    setGabaritoOpen(open);
    if (open && !gabaritoData) {
      startLoadGabarito(async () => {
        const result = await fetchGabaritoForComment(
          projectId,
          comment.documentId,
          comment.fieldName,
          comment.chosenResponseId,
        );
        setGabaritoData(result.answers);
      });
    }
  };

  return (
    <Card className={cn(isResolved && "opacity-60")}>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{comment.documentTitle}</p>
            <div className="flex items-center gap-1.5">
              <code className="text-xs font-mono text-muted-foreground/70">
                {comment.fieldName}
              </code>
              {isCoordinator && onEditField && comment.source !== "nota" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  onClick={onEditField}
                  title="Editar campo"
                >
                  <Pencil className="h-3 w-3" />
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

        <blockquote className="border-l-2 pl-3 text-sm text-foreground">
          {comment.comment}
        </blockquote>

        {/* Gabarito expansível (só para reviews, não para notas) */}
        {comment.source !== "nota" && <Collapsible open={gabaritoOpen} onOpenChange={handleGabaritoToggle}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            >
              Ver gabarito
              {loadingGabarito ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform",
                    gabaritoOpen && "rotate-180",
                  )}
                />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1 space-y-1.5 rounded-md bg-muted/50 p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">Gabarito:</span>
                <Badge
                  variant={verdictVariant(comment.verdict)}
                  className="text-xs"
                >
                  {formatVerdictLabel(comment.verdict)}
                </Badge>
              </div>
              {gabaritoData && gabaritoData.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Respostas dos respondentes:
                  </span>
                  {gabaritoData.map((a, i) => (
                    <div
                      key={i}
                      className={cn(
                        "flex items-start gap-2 rounded px-2 py-1 text-xs",
                        a.isChosen && "bg-brand/5",
                      )}
                    >
                      {a.isChosen && (
                        <Check className="mt-0.5 h-3 w-3 shrink-0 text-brand" />
                      )}
                      <div className="min-w-0">
                        <span className="font-medium">
                          {a.respondentName}
                        </span>
                        <Badge
                          variant="outline"
                          className="ml-1.5 text-[10px] px-1 py-0"
                        >
                          {a.respondentType === "humano" ? "Humano" : "LLM"}
                        </Badge>
                        <span className="ml-2 text-muted-foreground">
                          {formatAnswer(a.answer)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : gabaritoData && gabaritoData.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nenhuma resposta encontrada.
                </p>
              ) : null}
            </div>
          </CollapsibleContent>
        </Collapsible>}

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
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
