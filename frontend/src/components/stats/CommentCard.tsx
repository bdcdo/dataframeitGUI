"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { resolveSchemaSuggestion } from "@/actions/suggestions";
import { SuggestionDiff } from "./SuggestionDiff";
import { toast } from "sonner";

const TYPE_LABELS: Record<string, string> = {
  single: "Escolha única",
  multi: "Múltipla escolha",
  text: "Texto livre",
  date: "Data",
};

const TYPE_COLORS: Record<string, string> = {
  single: "bg-blue-500/10 text-blue-700",
  multi: "bg-purple-500/10 text-purple-700",
  text: "bg-green-500/10 text-green-700",
  date: "bg-amber-500/10 text-amber-700",
};

export interface ResponseSnapshotEntry {
  id: string;
  respondent_name: string;
  respondent_type: "humano" | "llm";
  answer: unknown;
  justification?: string;
}

export interface ReviewComment {
  id: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  fieldHelpText?: string;
  fieldOptions?: string[] | null;
  fieldType?: "single" | "multi" | "text" | "date";
  verdict: string;
  comment: string;
  reviewerName: string;
  resolvedAt: string | null;
  createdAt: string;
  chosenResponseId: string | null;
  source: "review" | "nota" | "sugestao" | "dificuldade" | "anotacao" | "duvida";
  responseSnapshot: ResponseSnapshotEntry[] | null;
  suggestionId?: string;
  suggestionStatus?: "pending" | "approved" | "rejected";
  suggestionChanges?: {
    description?: string;
    help_text?: string | null;
    options?: string[] | null;
  };
  fieldSnapshot?: {
    description: string;
    help_text: string | null;
    options: string[] | null;
  };
  difficultyResponseId?: string;
  difficultyDocumentId?: string;
  duvidaReviewId?: string;
  duvidaRespondentId?: string;
}

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

function formatVerdictLabel(verdict: string): string {
  if (verdict === "nota") return "Nota do pesquisador";
  if (verdict === "anotacao") return "Anotação";
  if (verdict === "dificuldade") return "Dificuldade do LLM";
  if (verdict === "sugestao") return "Sugestão";
  if (verdict === "duvida") return "Dúvida do gabarito";
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
  if (verdict === "anotacao") return "secondary";
  if (verdict === "dificuldade") return "secondary";
  if (verdict === "sugestao") return "outline";
  if (verdict === "duvida") return "secondary";
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
  onSuggestField,
  onOpenDocument,
}: CommentCardProps) {
  const router = useRouter();
  const isResolved = !!comment.resolvedAt;
  const [suggestionPending, startSuggestionAction] = useTransition();
  const [gabaritoOpen, setGabaritoOpen] = useState(false);
  const [gabaritoData, setGabaritoData] = useState<
    GabaritoRespondentAnswer[] | null
  >(null);
  const [loadingGabarito, startLoadGabarito] = useTransition();

  // If snapshot exists, convert to gabarito format immediately
  const snapshotAsGabarito: GabaritoRespondentAnswer[] | null =
    comment.responseSnapshot
      ? comment.responseSnapshot.map((r) => ({
          respondentName: r.respondent_name,
          respondentType: r.respondent_type,
          answer: r.answer,
          isChosen: r.id === comment.chosenResponseId,
        }))
      : null;

  const handleGabaritoToggle = (open: boolean) => {
    setGabaritoOpen(open);
    // Only fetch if no snapshot and no cached data
    if (open && !gabaritoData && !snapshotAsGabarito) {
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

  const gabaritoEntries = snapshotAsGabarito ?? gabaritoData;

  return (
    <Card className={cn(isResolved && "opacity-60")}>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {onOpenDocument && comment.documentId ? (
              <button
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
              {isCoordinator && onEditField && comment.source !== "nota" && comment.source !== "dificuldade" && (
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
              {!isCoordinator && onSuggestField && comment.source !== "nota" && comment.source !== "dificuldade" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0"
                  onClick={onSuggestField}
                  title="Sugerir alteração"
                >
                  <Pencil className="h-3 w-3 text-amber-500" />
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

        {/* Suggestion actions (coordinator: review/reject)
            "Revisar" abre EditFieldDialog pré-preenchido (via onResolve);
            salvar lá aprova com os valores finais editados. */}
        {comment.source === "sugestao" && comment.suggestionId && (
          <div className="flex items-center gap-2">
            {comment.suggestionStatus === "pending" && isCoordinator && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  className="h-6 text-xs"
                  disabled={suggestionPending}
                  onClick={onResolve}
                  title="Abre editor para revisar antes de aprovar"
                >
                  Revisar
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-xs"
                  disabled={suggestionPending}
                  onClick={() => {
                    startSuggestionAction(async () => {
                      const result = await resolveSchemaSuggestion(comment.suggestionId!, projectId, "rejected");
                      if (result.error) toast.error(result.error);
                      else { toast.success("Sugestão rejeitada"); router.refresh(); }
                    });
                  }}
                >
                  Rejeitar
                </Button>
              </>
            )}
            {comment.suggestionStatus === "approved" && (
              <Badge className="text-xs bg-green-500/10 text-green-700">Aprovada</Badge>
            )}
            {comment.suggestionStatus === "rejected" && (
              <Badge className="text-xs bg-red-500/10 text-red-700">Rejeitada</Badge>
            )}
          </div>
        )}

        {/* Gabarito expansível (só para reviews, não para notas) */}
        {comment.source !== "nota" && comment.source !== "dificuldade" && comment.source !== "anotacao" && <Collapsible open={gabaritoOpen} onOpenChange={handleGabaritoToggle}>
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
              {gabaritoEntries && gabaritoEntries.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Respostas dos respondentes:
                  </span>
                  {gabaritoEntries.map((a, i) => (
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
              ) : gabaritoEntries && gabaritoEntries.length === 0 ? (
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
            {comment.source === "sugestao" ? null : isResolved ? (
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
