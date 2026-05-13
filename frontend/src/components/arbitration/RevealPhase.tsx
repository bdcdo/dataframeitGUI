"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";
import type { ArbitrationField } from "./ArbitrationPage";

interface RevealPhaseProps {
  fields: ArbitrationField[];
  fieldMeta: Map<string, PydanticField>;
  orderByField: Map<string, "human_first" | "llm_first">;
  arbitrationBlind: boolean;
  finalChoices: Record<string, ArbitrationVerdict>;
  suggestions: Record<string, string>;
  comments: Record<string, string>;
  blindChoices: Record<string, ArbitrationVerdict>;
  onChooseFinal: (field: string, verdict: ArbitrationVerdict) => void;
  onSuggestion: (field: string, v: string) => void;
  onComment: (field: string, v: string) => void;
}

function formatAnswer(v: unknown): string {
  if (v === null || v === undefined) return "(vazio)";
  if (typeof v === "string") return v.length === 0 ? "(vazio)" : v;
  if (Array.isArray(v)) return v.length === 0 ? "(vazio)" : v.join(", ");
  return JSON.stringify(v);
}

export function RevealPhase({
  fields,
  fieldMeta,
  orderByField,
  arbitrationBlind,
  finalChoices,
  suggestions,
  comments,
  blindChoices,
  onChooseFinal,
  onSuggestion,
  onComment,
}: RevealPhaseProps) {
  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const order = orderByField.get(f.fieldName) ?? "human_first";
        const final = finalChoices[f.fieldName];
        const blind = blindChoices[f.fieldName] ?? f.blindVerdict;
        const changed = blind && final && blind !== final;

        const humanLabel = arbitrationBlind
          ? `Resposta ${order === "human_first" ? "A" : "B"}`
          : `Humano${f.humanName ? ` (${f.humanName})` : ""}`;
        const llmLabel = arbitrationBlind
          ? `Resposta ${order === "human_first" ? "B" : "A"}`
          : `LLM${f.llmName ? ` (${f.llmName})` : ""}`;

        return (
          <Card key={f.fieldName}>
            <CardHeader>
              <CardTitle className="text-sm font-mono flex items-center justify-between">
                <span>{f.fieldName}</span>
                {blind ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    Fase cega: {blind === "humano" ? humanLabel : llmLabel}
                  </span>
                ) : null}
              </CardTitle>
              {fieldMeta.get(f.fieldName)?.description ? (
                <p className="text-sm text-muted-foreground">
                  {fieldMeta.get(f.fieldName)?.description}
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
                    {formatAnswer(f.humanAnswer)}
                  </div>
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
                    {formatAnswer(f.llmAnswer)}
                  </div>
                  {f.llmJustification ? (
                    <div className="mt-2 text-xs text-muted-foreground border-l-2 border-muted pl-2 whitespace-pre-wrap">
                      {f.llmJustification}
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
                  onClick={() => onChooseFinal(f.fieldName, "humano")}
                >
                  Humano acertou
                </Button>
                <Button
                  variant={final === "llm" ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => onChooseFinal(f.fieldName, "llm")}
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
                  <Label htmlFor={`sug-${f.fieldName}`} className="text-sm">
                    Sugestão de melhoria na redação da pergunta{" "}
                    <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id={`sug-${f.fieldName}`}
                    rows={3}
                    value={suggestions[f.fieldName] ?? ""}
                    onChange={(e) => onSuggestion(f.fieldName, e.target.value)}
                    placeholder="Como reformular a pergunta para evitar essa divergência no futuro?"
                  />
                </div>
              ) : null}

              <div className="space-y-2">
                <Label
                  htmlFor={`com-${f.fieldName}`}
                  className="text-sm text-muted-foreground"
                >
                  Comentário (opcional)
                </Label>
                <Textarea
                  id={`com-${f.fieldName}`}
                  rows={2}
                  value={comments[f.fieldName] ?? ""}
                  onChange={(e) => onComment(f.fieldName, e.target.value)}
                />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
