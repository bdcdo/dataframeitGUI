"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PydanticField } from "@/lib/types";
import { formatAnswerDisplay } from "@/lib/format-answer";
import type { ArbitrationField } from "./ArbitrationPage";

interface BlindPhaseProps {
  fields: ArbitrationField[];
  fieldMeta: Map<string, PydanticField>;
  // Choices indexadas por fieldReviewId (nao fieldName). A traducao A/B →
  // humano/llm acontece no servidor via assignOrder(fieldReviewId).
  choices: Record<string, "a" | "b">;
  onChoose: (fieldReviewId: string, choice: "a" | "b") => void;
}

export function BlindPhase({
  fields,
  fieldMeta,
  choices,
  onChoose,
}: BlindPhaseProps) {
  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const meta = fieldMeta.get(f.fieldName);
        // Re-entrada (voltar para a fase cega): derivar A/B do blindVerdict
        // ja gravado, usando reveal.aSide para saber quem e quem.
        const persistedChoice: "a" | "b" | null =
          f.blindVerdict != null && f.reveal != null
            ? f.reveal.aSide === f.blindVerdict
              ? "a"
              : "b"
            : null;
        const chosen = choices[f.fieldReviewId] ?? persistedChoice;
        const locked = f.blindVerdict !== null;

        return (
          <Card key={f.fieldReviewId}>
            <CardHeader>
              <CardTitle className="text-sm font-mono">{f.fieldName}</CardTitle>
              {meta?.description ? (
                <p className="text-sm text-muted-foreground">
                  {meta.description}
                </p>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => onChoose(f.fieldReviewId, "a")}
                  disabled={locked}
                  className={`border rounded-md p-3 text-left transition ${
                    chosen === "a"
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50"
                  } disabled:opacity-60`}
                >
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    Resposta A
                  </div>
                  <div className="text-sm font-medium">
                    {formatAnswerDisplay(f.aAnswer)}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onChoose(f.fieldReviewId, "b")}
                  disabled={locked}
                  className={`border rounded-md p-3 text-left transition ${
                    chosen === "b"
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50"
                  } disabled:opacity-60`}
                >
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    Resposta B
                  </div>
                  <div className="text-sm font-medium">
                    {formatAnswerDisplay(f.bAnswer)}
                  </div>
                </button>
              </div>
              {locked ? (
                <p className="text-xs text-muted-foreground">
                  Veredito cego já registrado. Avance para fase 2.
                </p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
