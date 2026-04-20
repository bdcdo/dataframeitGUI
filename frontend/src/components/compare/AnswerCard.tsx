"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Bot, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

interface AnswerCardProps {
  index: number;
  displayAnswer: string;
  respondentNames: string[];
  respondentCount: number;
  hasLlm: boolean;
  llmJustification?: string;
  staleCount: number;
  isChosen: boolean;
  versions: string[];
  onVote: () => void;
}

export function AnswerCard({
  index,
  displayAnswer,
  respondentNames,
  respondentCount,
  hasLlm,
  llmJustification,
  staleCount,
  isChosen,
  versions,
  onVote,
}: AnswerCardProps) {
  const [showJustification, setShowJustification] = useState(false);
  const allStale = staleCount > 0 && staleCount === respondentCount;

  return (
    <button
      onClick={onVote}
      className={cn(
        "w-full rounded-lg border p-2.5 text-left transition-colors hover:bg-accent/50",
        isChosen ? "border-green-500/50 bg-green-500/5" : "border-muted",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-xs font-medium">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm">{displayAnswer}</p>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default underline decoration-dotted underline-offset-2">
                  {respondentCount}{" "}
                  {respondentCount === 1 ? "respondente" : "respondentes"}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {respondentNames.map((name) => (
                  <div key={name}>{name}</div>
                ))}
              </TooltipContent>
            </Tooltip>

            {hasLlm && (
              <span className="inline-flex items-center gap-1 text-brand">
                <Bot className="h-3 w-3" />
                LLM
              </span>
            )}

            {staleCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertTriangle className="h-3 w-3" />
                {allStale
                  ? "desatualizada"
                  : `${staleCount} de ${respondentCount} desatualizadas`}
              </span>
            )}

            {versions.length === 1 && (
              <span
                className="font-mono text-[10px] text-muted-foreground"
                title="Versão do schema em que esta resposta foi salva"
              >
                v{versions[0]}
              </span>
            )}
            {versions.length > 1 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default font-mono text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2">
                    {versions.length} versões
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {versions.map((v) => (
                    <div key={v}>v{v}</div>
                  ))}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {hasLlm && llmJustification && (
            <div className="mt-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowJustification(!showJustification);
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {showJustification ? <ChevronDown className="inline h-3 w-3" /> : <ChevronRight className="inline h-3 w-3" />}{" "}Justificativa
              </button>
              {showJustification && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {llmJustification}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
