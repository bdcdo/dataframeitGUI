"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
  ConfusionData,
  ConfusionDataSingle,
  ConfusionDataMulti,
  ConfusionDataText,
} from "@/app/(app)/projects/[id]/stats/reviews/page";

interface ConfusionMatrixProps {
  confusionDataList: ConfusionData[];
}

export function ConfusionMatrix({ confusionDataList }: ConfusionMatrixProps) {
  const [selectedField, setSelectedField] = useState(
    confusionDataList[0]?.fieldName || "",
  );

  if (confusionDataList.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nenhum campo com dados suficientes para gerar a matriz.
      </p>
    );
  }

  const current = confusionDataList.find((d) => d.fieldName === selectedField);

  return (
    <div className="space-y-4">
      <Select value={selectedField} onValueChange={setSelectedField}>
        <SelectTrigger className="w-64">
          <SelectValue placeholder="Selecionar campo" />
        </SelectTrigger>
        <SelectContent>
          {confusionDataList.map((d) => (
            <SelectItem key={d.fieldName} value={d.fieldName}>
              {d.fieldDescription} ({d.type})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {current?.type === "single" && <SingleConfusionGrid data={current} />}
      {current?.type === "multi" && <MultiOptionBars data={current} />}
      {current?.type === "text" && <TextConcordance data={current} />}
    </div>
  );
}

/* ── Single: Confusion Matrix Grid ── */

function SingleConfusionGrid({ data }: { data: ConfusionDataSingle }) {
  const { options, matrix } = data;

  // Filtrar labels que têm pelo menos 1 ocorrência
  const activeLabels = options.filter((label) => {
    const rowSum = Object.values(matrix[label] || {}).reduce((a, b) => a + b, 0);
    const colSum = options.reduce((a, opt) => a + (matrix[opt]?.[label] || 0), 0);
    return rowSum > 0 || colSum > 0;
  });

  if (activeLabels.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Sem dados suficientes para este campo.
      </p>
    );
  }

  // Calcular máximo para escala de cor
  const maxVal = Math.max(
    1,
    ...activeLabels.flatMap((row) =>
      activeLabels.map((col) => (row !== col ? matrix[row]?.[col] || 0 : 0)),
    ),
  );

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Linhas = resposta dada &middot; Colunas = gabarito
      </p>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left text-xs font-normal text-muted-foreground" />
              {activeLabels.map((label) => (
                <th
                  key={label}
                  className="max-w-[100px] truncate px-2 py-1 text-center text-xs font-medium"
                  title={label}
                >
                  {label}
                </th>
              ))}
              <th className="px-2 py-1 text-center text-xs font-normal text-muted-foreground">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {activeLabels.map((rowLabel) => {
              const rowTotal = activeLabels.reduce(
                (sum, col) => sum + (matrix[rowLabel]?.[col] || 0),
                0,
              );
              return (
                <tr key={rowLabel}>
                  <td
                    className="max-w-[120px] truncate px-2 py-1 text-xs font-medium"
                    title={rowLabel}
                  >
                    {rowLabel}
                  </td>
                  {activeLabels.map((colLabel) => {
                    const val = matrix[rowLabel]?.[colLabel] || 0;
                    const isDiagonal = rowLabel === colLabel;
                    const opacity =
                      !isDiagonal && val > 0
                        ? Math.max(0.15, val / maxVal)
                        : 0;

                    return (
                      <td
                        key={colLabel}
                        className={cn(
                          "min-w-[48px] px-2 py-1 text-center tabular-nums",
                          isDiagonal && val > 0 &&
                            "bg-emerald-100 font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
                        )}
                        style={
                          !isDiagonal && val > 0
                            ? {
                                backgroundColor: `oklch(0.65 0.15 25 / ${opacity})`,
                              }
                            : undefined
                        }
                      >
                        {val || ""}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1 text-center text-xs text-muted-foreground tabular-nums">
                    {rowTotal}
                  </td>
                </tr>
              );
            })}
            {/* Totals row */}
            <tr className="border-t">
              <td className="px-2 py-1 text-xs text-muted-foreground">
                Total
              </td>
              {activeLabels.map((colLabel) => {
                const colTotal = activeLabels.reduce(
                  (sum, row) => sum + (matrix[row]?.[colLabel] || 0),
                  0,
                );
                return (
                  <td
                    key={colLabel}
                    className="px-2 py-1 text-center text-xs text-muted-foreground tabular-nums"
                  >
                    {colTotal}
                  </td>
                );
              })}
              <td className="px-2 py-1 text-center text-xs font-medium tabular-nums">
                {data.total}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Multi: Option Accuracy Bars ── */

function MultiOptionBars({ data }: { data: ConfusionDataMulti }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Acurácia por opção (respondente acertou a seleção/não-seleção)
      </p>
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

/* ── Text: Concordance Rate ── */

function TextConcordance({ data }: { data: ConfusionDataText }) {
  return (
    <Card>
      <CardContent className="pt-6 text-center">
        <p className="text-3xl font-bold tabular-nums">{data.concordanceRate}%</p>
        <p className="text-sm text-muted-foreground">
          Concordância exata ({data.concordant}/{data.total})
        </p>
      </CardContent>
    </Card>
  );
}
