"use client";

import { useMemo } from "react";
import { AnswerCard } from "./AnswerCard";
import { TooltipProvider } from "@/components/ui/tooltip";

interface AgreementResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answer: unknown;
  justification?: string;
  is_current: boolean;
  isFieldStale: boolean;
}

interface ExistingVerdict {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

interface AgreementGroupProps {
  responses: AgreementResponse[];
  existingVerdict: ExistingVerdict | null;
  onVote: (displayAnswer: string, chosenResponseId: string) => void;
}

function formatAnswer(answer: unknown): string {
  if (answer == null) return "";
  if (Array.isArray(answer)) return answer.join(", ");
  return String(answer);
}

export function AgreementGroup({
  responses,
  existingVerdict,
  onVote,
}: AgreementGroupProps) {
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { displayAnswer: string; responses: AgreementResponse[] }
    >();
    for (const r of responses) {
      if (r.answer === undefined) continue;
      const key = JSON.stringify(r.answer);
      if (!map.has(key)) {
        map.set(key, { displayAnswer: formatAnswer(r.answer), responses: [] });
      }
      map.get(key)!.responses.push(r);
    }
    const result = [...map.values()];
    result.sort((a, b) => b.responses.length - a.responses.length);
    return result;
  }, [responses]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-1.5">
        {groups.map((group, i) => {
          const hasLlm = group.responses.some(
            (r) => r.respondent_type === "llm",
          );
          const llmResponse = group.responses.find(
            (r) => r.respondent_type === "llm",
          );
          const staleCount = group.responses.filter(
            (r) => r.isFieldStale,
          ).length;
          const isChosen = group.responses.some(
            (r) => r.id === existingVerdict?.chosenResponseId,
          );

          return (
            <AnswerCard
              key={group.displayAnswer}
              index={i}
              displayAnswer={group.displayAnswer}
              respondentNames={group.responses.map((r) => r.respondent_name)}
              respondentCount={group.responses.length}
              hasLlm={hasLlm}
              llmJustification={llmResponse?.justification}
              staleCount={staleCount}
              isChosen={isChosen}
              onVote={() => onVote(group.displayAnswer, group.responses[0].id)}
            />
          );
        })}
      </div>
    </TooltipProvider>
  );
}
