"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { computeInitialChoices } from "@/lib/compare-multi-choices";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

interface MultiOptionResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answer: unknown;
  is_latest: boolean;
  isFieldStale: boolean;
}

interface ExistingVerdict {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

interface MultiOptionReviewProps {
  options: string[];
  responses: MultiOptionResponse[];
  existingVerdict: ExistingVerdict | null;
  isSubmitting: boolean;
  onSubmit: (verdictJson: string) => void;
}

export function MultiOptionReview({
  options,
  responses,
  existingVerdict,
  isSubmitting,
  onSubmit,
}: MultiOptionReviewProps) {
  // Count how many respondents selected each option
  const optionStats = useMemo(() => {
    const activeResponses = responses.filter(
      (r) => r.answer !== undefined,
    );
    const totalRespondents = activeResponses.length;

    return options.map((opt) => {
      const selected = activeResponses.filter((r) => {
        const arr = r.answer;
        return Array.isArray(arr) && arr.includes(opt);
      });
      const notSelected = activeResponses.filter((r) => {
        const arr = r.answer;
        return !Array.isArray(arr) || !arr.includes(opt);
      });
      const isDivergent = selected.length > 0 && selected.length < totalRespondents;

      return {
        option: opt,
        selectedCount: selected.length,
        totalRespondents,
        selectedNames: selected.map((r) => r.respondent_name),
        notSelectedNames: notSelected.map((r) => r.respondent_name),
        isDivergent,
      };
    });
  }, [options, responses]);

  // Escolhas iniciais: verdict existente, senão a maioria por opção.
  // O reset ao trocar de documento/campo é feito pelo `key` no pai
  // (ComparisonPanel, igual ao AgreementGroup): a troca de key remonta o
  // componente e este inicializador roda de novo — sem effect de derivação.
  const [choices, setChoices] = useState<Record<string, boolean>>(() =>
    computeInitialChoices(existingVerdict?.verdict, optionStats),
  );

  const toggleOption = (opt: string) => {
    if (isSubmitting) return;
    setChoices((prev) => ({ ...prev, [opt]: !prev[opt] }));
  };

  const handleSubmit = () => {
    if (isSubmitting) return;
    onSubmit(JSON.stringify(choices));
  };

  // Keyboard shortcuts: 1-N toggle options, Enter submits.
  // Listener de teclado registra uma vez; handlers frescos chegam via ref
  // para evitar re-registro a cada tecla.
  const keyHandlersRef = useRef({ handleSubmit, toggleOption, options });
  useEffect(() => {
    keyHandlersRef.current = { handleSubmit, toggleOption, options };
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const { handleSubmit, toggleOption, options } = keyHandlersRef.current;

      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
        return;
      }

      const num = parseInt(e.key);
      if (num >= 1 && num <= Math.min(9, options.length)) {
        toggleOption(options[num - 1]);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-1">
        {optionStats.map((stat, i) => (
          <label
            key={stat.option}
            className={cn(
              "flex items-center gap-2.5 rounded-lg border p-2.5 transition-colors",
              isSubmitting
                ? "cursor-not-allowed opacity-60"
                : "cursor-pointer hover:bg-accent/50",
              stat.isDivergent
                ? "border-amber-500/30 bg-amber-500/5"
                : "border-muted",
            )}
          >
            <Checkbox
              checked={choices[stat.option] ?? false}
              disabled={isSubmitting}
              onCheckedChange={() => toggleOption(stat.option)}
            />
            <div className="min-w-0 flex-1">
              <span className="text-sm">{stat.option}</span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "shrink-0 cursor-default text-xs underline decoration-dotted underline-offset-2",
                    stat.isDivergent
                      ? "text-amber-600"
                      : "text-muted-foreground",
                  )}
                >
                  {stat.selectedCount}/{stat.totalRespondents}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left">
                {stat.selectedCount > 0 && (
                  <div>
                    <span className="font-medium">Marcaram:</span>{" "}
                    {stat.selectedNames.join(", ")}
                  </div>
                )}
                {stat.notSelectedNames.length > 0 && (
                  <div>
                    <span className="font-medium">Nao marcaram:</span>{" "}
                    {stat.notSelectedNames.join(", ")}
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
            {i < 9 && (
              <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">
                {i + 1}
              </span>
            )}
          </label>
        ))}

        <Button
          size="sm"
          className="mt-2 w-full"
          disabled={isSubmitting}
          onClick={handleSubmit}
        >
          {isSubmitting ? "Salvando..." : "[Enter] Confirmar"}
        </Button>
      </div>
    </TooltipProvider>
  );
}
