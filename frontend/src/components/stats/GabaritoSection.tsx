"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, Loader2, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchGabaritoForComment,
  type GabaritoRespondentAnswer,
} from "@/actions/stats";
import { formatAnswer } from "@/lib/reviews/verdict-format";
import {
  type ReviewComment,
  formatVerdictLabel,
  verdictVariant,
} from "./comment-card-utils";

interface GabaritoSectionProps {
  comment: ReviewComment;
  projectId: string;
}

export function GabaritoSection({ comment, projectId }: GabaritoSectionProps) {
  const [gabaritoOpen, setGabaritoOpen] = useState(false);
  const [gabaritoData, setGabaritoData] = useState<
    GabaritoRespondentAnswer[] | null
  >(null);
  const [loadingGabarito, startLoadGabarito] = useTransition();

  // If snapshot exists, convert to gabarito format immediately
  const snapshotAsGabarito: GabaritoRespondentAnswer[] | null =
    comment.responseSnapshot
      ? comment.responseSnapshot.map((r) => ({
          id: r.id,
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
    <Collapsible open={gabaritoOpen} onOpenChange={handleGabaritoToggle}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
        >
          Ver gabarito
          {loadingGabarito ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
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
              {gabaritoEntries.map((a) => (
                <div
                  key={a.id}
                  className={cn(
                    "flex items-start gap-2 rounded px-2 py-1 text-xs",
                    a.isChosen && "bg-brand/5",
                  )}
                >
                  {a.isChosen && (
                    <Check className="mt-0.5 size-3 shrink-0 text-brand" />
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
    </Collapsible>
  );
}
