"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  ConfusionData,
  ConfusionDataSingle,
  ConfusionDataMulti,
} from "@/app/(app)/projects/[id]/reviews/page";

interface ConfusionMatrixProps {
  confusionDataList: ConfusionData[];
}

export function ConfusionMatrix({ confusionDataList }: ConfusionMatrixProps) {
  if (confusionDataList.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nenhum campo com dados suficientes para análise de confusão.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {confusionDataList.map((data) => (
        <Card key={data.fieldName}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">
                {data.fieldDescription}
              </CardTitle>
              <Badge variant="outline" className="text-xs">
                {data.type === "single" ? "Escolha única" : "Múltipla escolha"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {data.type === "single" && <SingleConfusionGrid data={data} />}
            {data.type === "multi" && <MultiOptionBars data={data} />}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ── Single: Confusion Matrix Grid ── */

function SingleConfusionGrid({ data }: { data: ConfusionDataSingle }) {
  const { options, matrix } = data;

  const activeLabels = options.filter((label) => {
    const rowSum = Object.values(matrix[label] || {}).reduce((a, b) => a + b, 0);
    const colSum = options.reduce((a, opt) => a + (matrix[opt]?.[label] || 0), 0);
    return rowSum > 0 || colSum > 0;
  });

  if (activeLabels.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">
        Sem dados suficientes.
      </p>
    );
  }

  // Acurácia geral deste campo
  let totalCorrect = 0;
  let totalAll = 0;
  for (const label of activeLabels) {
    for (const col of activeLabels) {
      const val = matrix[label]?.[col] || 0;
      totalAll += val;
      if (label === col) totalCorrect += val;
    }
  }
  const accuracy = totalAll > 0 ? Math.round((totalCorrect / totalAll) * 100) : 0;

  const maxOffDiag = Math.max(
    1,
    ...activeLabels.flatMap((row) =>
      activeLabels.map((col) => (row !== col ? matrix[row]?.[col] || 0 : 0)),
    ),
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Acurácia geral:
        </span>
        <span
          className={cn(
            "text-sm font-bold tabular-nums",
            accuracy >= 80
              ? "text-emerald-600"
              : accuracy >= 50
                ? "text-amber-600"
                : "text-red-600",
          )}
        >
          {accuracy}%
        </span>
        <span className="text-xs text-muted-foreground">
          ({totalCorrect}/{totalAll})
        </span>
      </div>

      <div className="flex gap-4 text-[10px] text-muted-foreground">
        <span>Linhas = resposta dada</span>
        <span>Colunas = gabarito</span>
      </div>

      <div className="overflow-x-auto">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="p-0" />
              {activeLabels.map((label) => (
                <th
                  key={label}
                  className="max-w-[90px] truncate px-1 pb-1 text-center font-medium"
                  title={label}
                >
                  {label.length > 10 ? label.slice(0, 10) + "…" : label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeLabels.map((rowLabel) => (
              <tr key={rowLabel}>
                <td
                  className="max-w-[100px] truncate pr-2 text-right font-medium"
                  title={rowLabel}
                >
                  {rowLabel.length > 12 ? rowLabel.slice(0, 12) + "…" : rowLabel}
                </td>
                {activeLabels.map((colLabel) => {
                  const val = matrix[rowLabel]?.[colLabel] || 0;
                  const isDiagonal = rowLabel === colLabel;
                  const opacity =
                    !isDiagonal && val > 0
                      ? Math.max(0.12, val / maxOffDiag)
                      : 0;

                  return (
                    <td key={colLabel} className="p-0.5">
                      <div
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded text-xs font-medium tabular-nums",
                          isDiagonal && val > 0 &&
                            "bg-brand/15 text-brand font-bold",
                          isDiagonal && val === 0 && "bg-muted/50 text-muted-foreground",
                          !isDiagonal && val === 0 && "bg-muted/30 text-muted-foreground/50",
                        )}
                        style={
                          !isDiagonal && val > 0
                            ? { backgroundColor: `oklch(0.70 0.18 25 / ${opacity})`, color: "oklch(0.35 0.12 25)" }
                            : undefined
                        }
                        title={`${rowLabel} → ${colLabel}: ${val}`}
                      >
                        {val || "·"}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Multi: Option Accuracy Bars ── */

function MultiOptionBars({ data }: { data: ConfusionDataMulti }) {
  const overallCorrect = data.options.reduce((s, o) => s + o.correct, 0);
  const overallTotal = data.options.reduce((s, o) => s + o.total, 0);
  const overallAccuracy = overallTotal > 0 ? Math.round((overallCorrect / overallTotal) * 100) : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Acurácia geral:
        </span>
        <span
          className={cn(
            "text-sm font-bold tabular-nums",
            overallAccuracy >= 80
              ? "text-emerald-600"
              : overallAccuracy >= 50
                ? "text-amber-600"
                : "text-red-600",
          )}
        >
          {overallAccuracy}%
        </span>
      </div>

      {data.options.map((opt) => (
        <div key={opt.option} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="truncate">{opt.option}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {opt.accuracy}% ({opt.correct}/{opt.total})
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                opt.accuracy >= 80
                  ? "bg-emerald-500"
                  : opt.accuracy >= 50
                    ? "bg-amber-500"
                    : "bg-red-500",
              )}
              style={{ width: `${opt.accuracy}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
