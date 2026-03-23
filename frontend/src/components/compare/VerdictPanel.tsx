"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface ExistingVerdict {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

interface VerdictResponse {
  id: string;
  respondent_name: string;
  answer: unknown;
}

interface VerdictPanelProps {
  responses: VerdictResponse[];
  existingVerdict: ExistingVerdict | null;
  onSubmit: (
    verdict: string,
    chosenResponseId?: string,
    comment?: string,
  ) => void;
}

function formatAnswer(answer: unknown): string {
  if (answer == null) return "";
  if (Array.isArray(answer)) return answer.join(", ");
  return String(answer);
}

export function VerdictPanel({
  responses,
  existingVerdict,
  onSubmit,
}: VerdictPanelProps) {
  const [comment, setComment] = useState(existingVerdict?.comment || "");

  const groups = useMemo(() => {
    const map = new Map<string, VerdictResponse[]>();
    for (const r of responses) {
      const key = JSON.stringify(r.answer);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    const result: {
      key: string;
      displayAnswer: string;
      responses: VerdictResponse[];
    }[] = [];
    for (const [key, members] of map) {
      result.push({
        key,
        displayAnswer: formatAnswer(members[0].answer),
        responses: members,
      });
    }
    result.sort((a, b) => b.responses.length - a.responses.length);
    return result;
  }, [responses]);

  const handleSubmit = (verdict: string, chosenResponseId?: string) => {
    onSubmit(verdict, chosenResponseId, comment);
    setComment("");
    toast.success("Veredito salvo!");
  };

  return (
    <div className="space-y-2">
      {existingVerdict && (
        <div className="rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          Veredito anterior:{" "}
          <span className="font-medium text-foreground">
            {existingVerdict.verdict}
          </span>
          {existingVerdict.comment && (
            <span className="ml-1">
              &mdash; &ldquo;{existingVerdict.comment}&rdquo;
            </span>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {groups.map((group, i) => {
          const isExisting = group.responses.some(
            (r) => existingVerdict?.chosenResponseId === r.id,
          );
          const names = group.responses
            .map((r) => r.respondent_name)
            .join(", ");
          const truncated =
            group.displayAnswer.length > 40
              ? group.displayAnswer.slice(0, 40) + "\u2026"
              : group.displayAnswer;

          return (
            <Button
              key={group.key}
              variant="outline"
              size="sm"
              className={cn(
                "text-left",
                isExisting && "border-brand bg-brand/10 text-brand",
              )}
              onClick={() =>
                handleSubmit(group.displayAnswer, group.responses[0].id)
              }
            >
              [{i + 1}] &ldquo;{truncated}&rdquo; ({names})
            </Button>
          );
        })}
        <Button
          variant="outline"
          size="sm"
          className={cn(
            existingVerdict?.verdict === "ambiguo" &&
              "border-brand bg-brand/10 text-brand",
          )}
          onClick={() => handleSubmit("ambiguo")}
        >
          [A] Ambíguo
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            existingVerdict?.verdict === "pular" &&
              "border-brand bg-brand/10 text-brand",
          )}
          onClick={() => handleSubmit("pular")}
        >
          [S] Pular
        </Button>
      </div>
      <Input
        placeholder="Comentário (opcional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="text-sm"
      />
    </div>
  );
}
