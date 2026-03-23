"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { User, Bot, CheckCircle2 } from "lucide-react";

interface ResponseCardProps {
  response: {
    id: string;
    respondent_type: "humano" | "llm";
    respondent_name: string;
    answer: string | string[];
    justification?: string;
    is_current: boolean;
  };
  index: number;
  isSelected: boolean;
  isChosen?: boolean;
  onSelect: () => void;
}

export function ResponseCard({ response, index, isSelected, isChosen, onSelect }: ResponseCardProps) {
  const [showJustification, setShowJustification] = useState(false);
  const isLlm = response.respondent_type === "llm";

  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors",
        isLlm ? "border-brand/50" : "border-muted",
        isSelected && "ring-2 ring-brand bg-brand/5",
        isChosen && "border-green-500/50 bg-green-500/5",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-muted text-xs font-medium">{index + 1}</span>
          {isLlm ? (
            <Bot className="h-3.5 w-3.5 text-brand" />
          ) : (
            <User className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">{response.respondent_name}</span>
          {isLlm && <Badge variant="outline" className="border-brand/50 text-brand text-xs">LLM</Badge>}
        </div>
        <div className="flex items-center gap-1.5">
          {isChosen && (
            <Badge variant="outline" className="border-green-500/50 text-green-600 text-xs gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Escolhido
            </Badge>
          )}
          {!response.is_current && isLlm && (
            <Badge variant="destructive" className="text-xs">Desatualizada</Badge>
          )}
        </div>
      </div>
      <div className="mt-2 text-sm">
        {Array.isArray(response.answer) ? response.answer.join(", ") : response.answer}
      </div>
      {response.justification && (
        <div className="mt-2">
          <button
            onClick={(e) => { e.stopPropagation(); setShowJustification(!showJustification); }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {showJustification ? "▼" : "▶"} Justificativa
          </button>
          {showJustification && (
            <p className="mt-1 text-xs text-muted-foreground">{response.justification}</p>
          )}
        </div>
      )}
    </button>
  );
}
