"use client";

import { useState, useEffect, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
  fieldName: string;
  existingVerdict: ExistingVerdict | null;
  onSubmit: (verdictJson: string) => void;
}

function parseExistingMultiVerdict(
  verdict: string | undefined,
): Record<string, boolean> | null {
  if (!verdict || !verdict.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(verdict);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch {
    // legacy string verdict — ignore
  }
  return null;
}

export function MultiOptionReview({
  options,
  responses,
  fieldName,
  existingVerdict,
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

  // Initialize choices from existing verdict or majority
  const [choices, setChoices] = useState<Record<string, boolean>>(() => {
    const existing = parseExistingMultiVerdict(existingVerdict?.verdict);
    if (existing) return existing;
    // Default: follow majority
    const result: Record<string, boolean> = {};
    for (const stat of optionStats) {
      result[stat.option] = stat.selectedCount > stat.totalRespondents / 2;
    }
    return result;
  });

  // Stable key derived from optionStats to detect when responses change
  const statsKey = useMemo(
    () => optionStats.map((s) => `${s.option}:${s.selectedCount}/${s.totalRespondents}`).join("|"),
    [optionStats]
  );

  // Reset choices when field, verdict, or response stats change
  useEffect(() => {
    const existing = parseExistingMultiVerdict(existingVerdict?.verdict);
    if (existing) {
      setChoices(existing);
    } else {
      const result: Record<string, boolean> = {};
      for (const stat of optionStats) {
        result[stat.option] = stat.selectedCount > stat.totalRespondents / 2;
      }
      setChoices(result);
    }
  }, [fieldName, existingVerdict?.verdict, statsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleOption = (opt: string) => {
    setChoices((prev) => ({ ...prev, [opt]: !prev[opt] }));
  };

  const handleSubmit = () => {
    onSubmit(JSON.stringify(choices));
  };

  // Keyboard shortcuts: 1-N toggle options, Enter submits
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

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
  }, [options, choices]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-1">
        {optionStats.map((stat, i) => (
          <label
            key={stat.option}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 transition-colors hover:bg-accent/50",
              stat.isDivergent
                ? "border-amber-500/30 bg-amber-500/5"
                : "border-muted",
            )}
          >
            <Checkbox
              checked={choices[stat.option] ?? false}
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
          onClick={handleSubmit}
        >
          [Enter] Confirmar
        </Button>
      </div>
    </TooltipProvider>
  );
}
