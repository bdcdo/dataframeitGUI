"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ArbitrationVerdict, PydanticField } from "@/lib/types";
import type { ArbitrationField } from "./ArbitrationPage";

interface BlindPhaseProps {
  fields: ArbitrationField[];
  fieldMeta: Map<string, PydanticField>;
  orderByField: Map<string, "human_first" | "llm_first">;
  choices: Record<string, ArbitrationVerdict>;
  onChoose: (field: string, verdict: ArbitrationVerdict) => void;
}

function formatAnswer(v: unknown): string {
  if (v === null || v === undefined) return "(vazio)";
  if (typeof v === "string") return v.length === 0 ? "(vazio)" : v;
  if (Array.isArray(v)) return v.length === 0 ? "(vazio)" : v.join(", ");
  return JSON.stringify(v);
}

export function BlindPhase({
  fields,
  fieldMeta,
  orderByField,
  choices,
  onChoose,
}: BlindPhaseProps) {
  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const order = orderByField.get(f.fieldName) ?? "human_first";
        const a = order === "human_first" ? f.humanAnswer : f.llmAnswer;
        const b = order === "human_first" ? f.llmAnswer : f.humanAnswer;
        const aVerdict: ArbitrationVerdict =
          order === "human_first" ? "humano" : "llm";
        const bVerdict: ArbitrationVerdict =
          order === "human_first" ? "llm" : "humano";

        const chosen = choices[f.fieldName] ?? f.blindVerdict;

        return (
          <Card key={f.fieldName}>
            <CardHeader>
              <CardTitle className="text-sm font-mono">
                {f.fieldName}
              </CardTitle>
              {fieldMeta.get(f.fieldName)?.description ? (
                <p className="text-sm text-muted-foreground">
                  {fieldMeta.get(f.fieldName)?.description}
                </p>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => onChoose(f.fieldName, aVerdict)}
                  disabled={f.blindVerdict !== null}
                  className={`border rounded-md p-3 text-left transition ${
                    chosen === aVerdict
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50"
                  } disabled:opacity-60`}
                >
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    Resposta A
                  </div>
                  <div className="text-sm font-medium">{formatAnswer(a)}</div>
                </button>
                <button
                  type="button"
                  onClick={() => onChoose(f.fieldName, bVerdict)}
                  disabled={f.blindVerdict !== null}
                  className={`border rounded-md p-3 text-left transition ${
                    chosen === bVerdict
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50"
                  } disabled:opacity-60`}
                >
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    Resposta B
                  </div>
                  <div className="text-sm font-medium">{formatAnswer(b)}</div>
                </button>
              </div>
              {f.blindVerdict !== null ? (
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
