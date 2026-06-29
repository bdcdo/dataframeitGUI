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
  reviewerId: string | null;
  respondentName: string;
  answerDisplay: string;
}

interface GabaritoAffordance {
  isGabarito: boolean;
  onSetGabarito: () => void;
}

// Discriminated union over `selected`: encodes the invariant "gabarito never
// without selection" in the type. The `gabarito` affordance only exists in the
// `selected: true` branch, so an impossible state (gabarito on an unselected
// card) is unrepresentable. `undefined` ⇒ equivalence not allowed (no checkbox).
// Not exported: the sole consumer (AgreementGroup) builds the object inline and
// TS checks it structurally against the prop type — exporting would be dead code.
type EquivalenceMode =
  | { selected: false; onToggle: () => void }
  | {
      selected: true;
      onToggle: () => void;
      gabarito: GabaritoAffordance | null;
    };

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

  // Selection / equivalence affordances (only present when allowEquivalence).
  // Discriminated union: `gabarito` is only reachable on the selected branch.
  equivalenceMode?: EquivalenceMode;

  // When this card represents 2+ responses fused via equivalence pairs.
  equivalentVariants?: EquivalentVariant[];
  onUnmarkPair?: (pairId: string) => void;
  canUnmarkPair?: (variant: EquivalentVariant) => boolean;
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
  equivalenceMode,
  equivalentVariants,
  onUnmarkPair,
  canUnmarkPair,
}: AnswerCardProps) {
  const [showJustification, setShowJustification] = useState(false);
  const allStale = staleCount > 0 && staleCount === respondentCount;
  const fusedCount = equivalentVariants?.length ?? 0;
  const selected = equivalenceMode?.selected === true;
  // Gabarito radio is only reachable on the selected branch (invariant in type).
  const gabarito = equivalenceMode?.selected ? equivalenceMode.gabarito : null;

  return (
    <div
      className={cn(
        "relative isolate w-full rounded-lg border p-2.5 text-left transition-colors hover:bg-accent/50",
        "has-[[data-vote-target]:focus-visible]:outline-none has-[[data-vote-target]:focus-visible]:ring-2 has-[[data-vote-target]:focus-visible]:ring-ring has-[[data-vote-target]:focus-visible]:ring-offset-2",
        isChosen
          ? "border-green-500/50 bg-green-500/5"
          : selected
            ? "border-brand/60 bg-brand/5"
            : "border-muted",
      )}
    >
      {/*
        Vote target: a transparent <button> overlaying the whole card. The card
        itself is a plain <div> so the interactive controls below (checkbox,
        popover, gabarito radio) can be siblings of this button instead of
        nested inside it (nested interactive = invalid HTML, plus the manual
        role="button" that prefer-tag-over-role flagged). Any new interactive or
        hover child must be lifted above this overlay with `relative z-[2]`;
        non-interactive content stays below and clicking it votes
        (stretched-link pattern). The native <button> handles Enter/Space.
      */}
      <button
        type="button"
        data-vote-target
        onClick={onVote}
        aria-label={`Escolher esta resposta: ${displayAnswer || "(vazia)"}`}
        className="absolute inset-0 z-[1] cursor-pointer rounded-lg focus:outline-none"
      />
      <div className="flex items-start gap-2">
        {equivalenceMode && (
          <div className="relative z-[2] flex h-5 shrink-0 items-center">
            <Checkbox
              checked={equivalenceMode.selected}
              onCheckedChange={() => equivalenceMode.onToggle()}
              aria-label="Selecionar para marcar como equivalente"
              title="Selecionar como equivalente"
            />
          </div>
        )}
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-xs font-medium">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm">{displayAnswer}</p>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="relative z-[2] cursor-default underline decoration-dotted underline-offset-2">
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
                <Bot className="size-3" />
                LLM
              </span>
            )}

            {staleCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertTriangle className="size-3" />
                {allStale
                  ? "desatualizada"
                  : `${staleCount} de ${respondentCount} desatualizadas`}
              </span>
            )}

            {fusedCount > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="relative z-[2] inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand hover:bg-brand/15"
                    title="Variantes marcadas como equivalentes"
                  >
                    <Link2 className="size-3" />
                    {fusedCount} variante{fusedCount === 1 ? "" : "s"}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-2">
                  <p className="px-1 pb-1.5 text-xs font-medium">
                    Respostas equivalentes
                  </p>
                  <ul className="space-y-1">
                    {equivalentVariants!.map((v) => {
                      const showUnmark =
                        !!onUnmarkPair && (canUnmarkPair?.(v) ?? true);
                      return (
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
                          {showUnmark && (
                            <button
                              type="button"
                              onClick={() => onUnmarkPair!(v.pairId)}
                              className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              title="Desfazer equivalência"
                              aria-label="Desfazer equivalência"
                            >
                              <X className="size-3" />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </PopoverContent>
              </Popover>
            )}

            {versions.length === 1 && (
              <span
                className="relative z-[2] font-mono text-[10px] text-muted-foreground"
                title="Versão do schema em que esta resposta foi salva"
              >
                v{versions[0]}
              </span>
            )}
            {versions.length > 1 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="relative z-[2] cursor-default font-mono text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2">
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
                type="button"
                onClick={() => setShowJustification(!showJustification)}
                className="relative z-[2] text-xs text-muted-foreground hover:text-foreground"
              >
                {showJustification ? <ChevronDown className="inline size-3" /> : <ChevronRight className="inline size-3" />}{" "}Justificativa
              </button>
              {showJustification && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {llmJustification}
                </p>
              )}
            </div>
          )}
        </div>

        {gabarito && (
          <label
            className="relative z-[2] flex shrink-0 cursor-pointer items-center gap-1 rounded border border-brand/30 bg-background px-1.5 py-0.5 text-[10px] hover:bg-brand/5"
            title="Esta é a resposta que será registrada como gabarito"
          >
            <input
              type="radio"
              checked={gabarito.isGabarito}
              onChange={() => gabarito.onSetGabarito()}
              className="size-3 accent-brand"
            />
            <span className={cn(gabarito.isGabarito && "font-medium text-brand")}>
              Gabarito
            </span>
          </label>
        )}
      </div>
    </div>
  );
}
