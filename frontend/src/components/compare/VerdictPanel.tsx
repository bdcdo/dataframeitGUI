"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface VerdictPanelProps {
  responses: { id: string; respondent_name: string }[];
  onSubmit: (verdict: string, chosenResponseId?: string, comment?: string) => void;
}

export function VerdictPanel({ responses, onSubmit }: VerdictPanelProps) {
  const [comment, setComment] = useState("");

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {responses.map((r, i) => (
          <Button key={r.id} variant="outline" size="sm" onClick={() => onSubmit(r.respondent_name, r.id, comment)}>
            [{i + 1}] {r.respondent_name}
          </Button>
        ))}
        <Button variant="outline" size="sm" onClick={() => onSubmit("ambiguo", undefined, comment)}>
          [A] Ambíguo
        </Button>
        <Button variant="outline" size="sm" onClick={() => onSubmit("pular", undefined, comment)}>
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
