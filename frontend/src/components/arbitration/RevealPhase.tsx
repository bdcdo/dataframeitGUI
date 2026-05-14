"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";
import { formatAnswerDisplay } from "@/lib/format-answer";
import type { ArbitrationField } from "./ArbitrationPage";

interface RevealPhaseProps {
  fields: ArbitrationField[];
  fieldMeta: Map<string, PydanticField>;
  arbitrationBlind: boolean;
  // States vem keyed por fieldReviewId — UUID unico por (doc, campo). Evita
  // que escolhas vazem entre documentos com mesmo fieldName.
  finalChoices: Record<string, ArbitrationVerdict>;
  suggestions: Record<string, string>;
  comments: Record<string, string>;
  onChooseFinal: (fieldReviewId: string, verdict: ArbitrationVerdict) => void;
  onSuggestion: (fieldReviewId: string, v: string) => void;
  onComment: (fieldReviewId: string, v: string) => void;
}

export function RevealPhase({
  fields,
  fieldMeta,
  arbitrationBlind,
  finalChoices,
  suggestions,
  comments,
  onChooseFinal,
  onSuggestion,
  onComment,
}: RevealPhaseProps) {
  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const meta = fieldMeta.get(f.fieldName);
        const final = finalChoices[f.fieldReviewId];
        const blind = f.blindVerdict;
        const changed = blind && final && blind !== final;

        // reveal e populado quando blindVerdict !== null. Sao os labels que
        // o arbitro ja "conquistou" o direito de ver. Defensive: se reveal
        // estiver null (estado inconsistente), nao quebrar — fallback para
        // labels genericos.
        const r = f.reveal;
        const humanName = r?.humanName ?? null;
        const llmName = r?.llmName ?? null;
        const llmJustification = r?.llmJustification ?? null;
        const selfJustification = r?.selfJustification ?? null;

        // Identifica qual lado (A/B) o arbitro escolheu na fase cega
        const blindSideLetter: "A" | "B" | null = r
          ? r.aSide === blind
            ? "A"
            : "B"
          : null;

        // Labels da fase 2: A/B se arbitration_blind=true, Humano/LLM se false
        const humanLabel = arbitrationBlind
          ? `Resposta ${r?.aSide === "humano" ? "A" : "B"}`
          : `Humano${humanName ? ` (${humanName})` : ""}`;
        const llmLabel = arbitrationBlind
          ? `Resposta ${r?.aSide === "llm" ? "A" : "B"}`
          : `LLM${llmName ? ` (${llmName})` : ""}`;

        return (
          <Card key={f.fieldReviewId}>
            <CardHeader>
              <CardTitle className="text-sm font-mono flex items-center justify-between">
                <span>{f.fieldName}</span>
                {blind && blindSideLetter ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    Fase cega: Resposta {blindSideLetter}
                  </span>
                ) : null}
              </CardTitle>
              {meta?.description ? (
                <p className="text-sm text-muted-foreground">
                  {meta.description}
                </p>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div
                  className={`border rounded-md p-3 ${
                    final === "humano" ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    {humanLabel}
                  </div>
                  <div className="text-sm font-medium">
                    {formatAnswerDisplay(
                      r?.aSide === "humano" ? f.aAnswer : f.bAnswer,
                    )}
                  </div>
                  {selfJustification ? (
                    <div className="mt-2 text-xs text-muted-foreground border-l-2 border-muted pl-2 whitespace-pre-wrap">
                      {selfJustification}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground italic">
                      Pesquisador não forneceu justificativa para este campo.
                    </p>
                  )}
                </div>
                <div
                  className={`border rounded-md p-3 ${
                    final === "llm" ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    {llmLabel}
                  </div>
                  <div className="text-sm font-medium">
                    {formatAnswerDisplay(r?.aSide === "llm" ? f.aAnswer : f.bAnswer)}
                  </div>
                  {llmJustification ? (
                    <div className="mt-2 text-xs text-muted-foreground border-l-2 border-muted pl-2 whitespace-pre-wrap">
                      {llmJustification}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground italic">
                      LLM não forneceu justificativa para este campo.
                    </p>
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  variant={final === "humano" ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => onChooseFinal(f.fieldReviewId, "humano")}
                >
                  Humano acertou
                </Button>
                <Button
                  variant={final === "llm" ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => onChooseFinal(f.fieldReviewId, "llm")}
                >
                  LLM acertou
                </Button>
              </div>

              {changed ? (
                <p className="text-xs text-amber-600">
                  Você mudou de ideia após ver a justificativa.
                </p>
              ) : null}

              {final === "llm" ? (
                <div className="space-y-2">
                  <Label htmlFor={`sug-${f.fieldReviewId}`} className="text-sm">
                    Sugestão de melhoria na redação da pergunta{" "}
                    <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id={`sug-${f.fieldReviewId}`}
                    rows={3}
                    value={suggestions[f.fieldReviewId] ?? ""}
                    onChange={(e) =>
                      onSuggestion(f.fieldReviewId, e.target.value)
                    }
                    placeholder="Como reformular a pergunta para evitar essa divergência no futuro?"
                  />
                </div>
              ) : null}

              <div className="space-y-2">
                <Label
                  htmlFor={`com-${f.fieldReviewId}`}
                  className="text-sm text-muted-foreground"
                >
                  Comentário (opcional)
                </Label>
                <Textarea
                  id={`com-${f.fieldReviewId}`}
                  rows={2}
                  value={comments[f.fieldReviewId] ?? ""}
                  onChange={(e) => onComment(f.fieldReviewId, e.target.value)}
                />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
