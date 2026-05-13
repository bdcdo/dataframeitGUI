"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatAnswerDisplay } from "@/lib/format-answer";
import type { SelfVerdict } from "@/lib/types";

interface FieldVerdictRowProps {
  fieldName: string;
  fieldDescription: string | null;
  humanAnswer: unknown;
  llmAnswer: unknown;
  llmJustification: string | null;
  choice: SelfVerdict | null;
  onChoose: (v: SelfVerdict) => void;
}

export function FieldVerdictRow({
  fieldName,
  fieldDescription,
  humanAnswer,
  llmAnswer,
  llmJustification,
  choice,
  onChoose,
}: FieldVerdictRowProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-mono">{fieldName}</CardTitle>
        {fieldDescription ? (
          <p className="text-sm text-muted-foreground">{fieldDescription}</p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="border rounded-md p-3 bg-muted/30">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              Sua resposta
            </div>
            <div className="text-sm font-medium">{formatAnswerDisplay(humanAnswer)}</div>
          </div>
          <div className="border rounded-md p-3 bg-muted/30">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              Resposta do LLM
            </div>
            <div className="text-sm font-medium">{formatAnswerDisplay(llmAnswer)}</div>
            {llmJustification ? (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Justificativa do LLM
                </summary>
                <p className="mt-1 text-muted-foreground whitespace-pre-wrap">
                  {llmJustification}
                </p>
              </details>
            ) : null}
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            variant={choice === "contesta_llm" ? "default" : "outline"}
            className={cn(
              "flex-1",
              choice === "contesta_llm" && "bg-primary",
            )}
            onClick={() => onChoose("contesta_llm")}
          >
            Eu acertei (LLM errou)
          </Button>
          <Button
            variant={choice === "admite_erro" ? "default" : "outline"}
            className="flex-1"
            onClick={() => onChoose("admite_erro")}
          >
            LLM acertou (eu errei)
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
