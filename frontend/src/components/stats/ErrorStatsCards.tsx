"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Bot, AlertTriangle } from "lucide-react";

interface ErrorStatsCardsProps {
  totalLlmDocs: number;
  errorCount: number;
  errorRatePct: number;
  unreviewedLlmDocs?: number;
}

export function ErrorStatsCards({
  totalLlmDocs,
  errorCount,
  errorRatePct,
  unreviewedLlmDocs,
}: ErrorStatsCardsProps) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 pt-6">
            <Bot className="size-5 text-brand" />
            <div>
              <p className="text-2xl font-bold tabular-nums">
                {totalLlmDocs}
              </p>
              <p className="text-xs text-muted-foreground">
                Docs com LLM
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-6">
            <AlertTriangle className="size-5 text-red-500" />
            <div>
              <p className="text-2xl font-bold tabular-nums">
                {errorCount}
              </p>
              <p className="text-xs text-muted-foreground">
                Campos incorretos
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <p className="text-2xl font-bold tabular-nums">
              {errorRatePct}%
            </p>
            <p className="text-xs text-muted-foreground">Taxa de erro</p>
          </CardContent>
        </Card>
      </div>

      {!!unreviewedLlmDocs && unreviewedLlmDocs > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          {unreviewedLlmDocs} documento{unreviewedLlmDocs !== 1 ? "s" : ""} com respostas do LLM ainda não {unreviewedLlmDocs !== 1 ? "foram revisados" : "foi revisado"}.
          Erros só aparecem após a revisão humana.
        </p>
      )}
    </>
  );
}
