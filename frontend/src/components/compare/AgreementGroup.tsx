"use client";

import { useMemo } from "react";
import { ResponseCard } from "./ResponseCard";

interface AgreementResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answer: unknown;
  justification?: string;
  is_current: boolean;
}

interface AgreementGroupProps {
  responses: AgreementResponse[];
  selectedResponseId: string | null;
  onSelect: (id: string) => void;
  chosenResponseId: string | null;
  /** Global index offset so keyboard shortcuts match the displayed number */
  indexOffset?: number;
}

interface AnswerGroup {
  key: string;
  displayAnswer: string;
  responses: AgreementResponse[];
}

function formatAnswer(answer: unknown): string {
  if (answer == null) return "";
  if (Array.isArray(answer)) return answer.join(", ");
  return String(answer);
}

export function AgreementGroup({
  responses,
  selectedResponseId,
  onSelect,
  chosenResponseId,
  indexOffset = 0,
}: AgreementGroupProps) {
  const groups = useMemo(() => {
    const map = new Map<string, AgreementResponse[]>();
    for (const r of responses) {
      const key = JSON.stringify(r.answer);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    const result: AnswerGroup[] = [];
    for (const [key, members] of map) {
      result.push({
        key,
        displayAnswer: formatAnswer(members[0].answer),
        responses: members,
      });
    }
    // Sort: largest group first (majority on top)
    result.sort((a, b) => b.responses.length - a.responses.length);
    return result;
  }, [responses]);

  let globalIndex = indexOffset;

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const isAgreement = group.responses.length > 1;
        const cards = group.responses.map((r) => {
          const idx = globalIndex++;
          return (
            <ResponseCard
              key={r.id}
              response={{
                id: r.id,
                respondent_type: r.respondent_type,
                respondent_name: r.respondent_name,
                answer: formatAnswer(r.answer),
                justification: r.justification,
                is_current: r.is_current,
              }}
              index={idx}
              isSelected={selectedResponseId === r.id}
              isChosen={chosenResponseId === r.id}
              onSelect={() => onSelect(r.id)}
            />
          );
        });

        if (isAgreement) {
          return (
            <div
              key={group.key}
              className="rounded-lg border border-brand/20 bg-brand/5 p-2"
            >
              <p className="mb-2 text-xs font-medium text-brand">
                Concordam ({group.responses.length})
              </p>
              <div className="space-y-2">{cards}</div>
            </div>
          );
        }

        return <div key={group.key}>{cards}</div>;
      })}
    </div>
  );
}
