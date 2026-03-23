"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface ExistingVerdict {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

interface VerdictPanelProps {
  responses: { id: string; respondent_name: string }[];
  existingVerdict: ExistingVerdict | null;
  onSubmit: (verdict: string, chosenResponseId?: string, comment?: string) => void;
}

export function VerdictPanel({ responses, existingVerdict, onSubmit }: VerdictPanelProps) {
  const [comment, setComment] = useState(existingVerdict?.comment || "");

  const handleSubmit = (verdict: string, chosenResponseId?: string) => {
    onSubmit(verdict, chosenResponseId, comment);
    setComment("");
    toast.success("Veredito salvo!");
  };

  return (
    <div className="space-y-2">
      {existingVerdict && (
        <div className="rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          Veredito anterior: <span className="font-medium text-foreground">{existingVerdict.verdict}</span>
          {existingVerdict.comment && (
            <span className="ml-1">&mdash; &ldquo;{existingVerdict.comment}&rdquo;</span>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {responses.map((r, i) => {
          const isExisting = existingVerdict?.chosenResponseId === r.id;
          return (
            <Button
              key={r.id}
              variant="outline"
              size="sm"
              className={cn(
                isExisting && "border-brand bg-brand/10 text-brand",
              )}
              onClick={() => handleSubmit(r.respondent_name, r.id)}
            >
              [{i + 1}] {r.respondent_name}
            </Button>
          );
        })}
        <Button
          variant="outline"
          size="sm"
          className={cn(
            existingVerdict?.verdict === "ambiguo" && "border-brand bg-brand/10 text-brand",
          )}
          onClick={() => handleSubmit("ambiguo")}
        >
          [A] Ambíguo
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            existingVerdict?.verdict === "pular" && "border-brand bg-brand/10 text-brand",
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
