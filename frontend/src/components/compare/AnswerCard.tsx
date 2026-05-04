"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Bot,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Link2,
  X,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";

export interface EquivalentVariant {
  pairId: string; // response_equivalences.id
  respondentName: string;
  answerDisplay: string;
}

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

  // Selection / equivalence affordances (only used when allowEquivalence)
  selectable?: boolean;
  selected?: boolean;
  onSelectionToggle?: () => void;
  showGabarito?: boolean;
  isGabarito?: boolean;
  onSetGabarito?: () => void;

  // When this card represents 2+ responses fused via equivalence pairs.
  equivalentVariants?: EquivalentVariant[];
  onUnmarkPair?: (pairId: string) => void;
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
  selectable = false,
  selected = false,
  onSelectionToggle,
  showGabarito = false,
  isGabarito = false,
  onSetGabarito,
  equivalentVariants,
  onUnmarkPair,
}: AnswerCardProps) {
  const [showJustification, setShowJustification] = useState(false);
  const allStale = staleCount > 0 && staleCount === respondentCount;
  const fusedCount = equivalentVariants?.length ?? 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onVote}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onVote();
        }
      }}
      className={cn(
        "w-full cursor-pointer rounded-lg border p-2.5 text-left transition-colors hover:bg-accent/50",
        isChosen
          ? "border-green-500/50 bg-green-500/5"
          : selected
            ? "border-brand/60 bg-brand/5"
            : "border-muted",
      )}
    >
      <div className="flex items-start gap-2">
        {selectable && (
          <div
            className="flex h-5 shrink-0 items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={selected}
              onCheckedChange={() => onSelectionToggle?.()}
              aria-label="Selecionar para marcar como equivalente"
              title="Selecionar como equivalente"
            />
          </div>
        )}
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

            {fusedCount > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand hover:bg-brand/15"
                    title="Variantes marcadas como equivalentes"
                  >
                    <Link2 className="h-3 w-3" />
                    {fusedCount} variante{fusedCount === 1 ? "" : "s"}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-72 p-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="px-1 pb-1.5 text-xs font-medium">
                    Respostas equivalentes
                  </p>
                  <ul className="space-y-1">
                    {equivalentVariants!.map((v) => (
                      <li
                        key={v.pairId}
                        className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate">{v.answerDisplay}</p>
                          <p className="truncate text-[10px] text-muted-foreground">
                            {v.respondentName}
                          </p>
                        </div>
                        {onUnmarkPair && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onUnmarkPair(v.pairId);
                            }}
                            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            title="Desfazer equivalência"
                            aria-label="Desfazer equivalência"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
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

        {showGabarito && (
          <label
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-brand/30 bg-background px-1.5 py-0.5 text-[10px] hover:bg-brand/5"
            onClick={(e) => e.stopPropagation()}
            title="Esta é a resposta que será registrada como gabarito"
          >
            <input
              type="radio"
              checked={isGabarito}
              onChange={() => onSetGabarito?.()}
              className="h-3 w-3 accent-brand"
            />
            <span className={cn(isGabarito && "font-medium text-brand")}>
              Gabarito
            </span>
          </label>
        )}
      </div>
    </div>
  );
}
