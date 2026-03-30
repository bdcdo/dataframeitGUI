"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Download } from "lucide-react";

interface ExportPanelProps {
  projectId: string;
  projectName: string;
  individualHeaders: string[];
  individualRows: string[][];
  verdictHeaders: string[];
  verdictRows: string[][];
}

function escapeCsvField(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function buildCsv(headers: string[], rows: string[][]): string {
  const bom = "\uFEFF";
  const headerLine = headers.map(escapeCsvField).join(",");
  const dataLines = rows.map((row) => row.map(escapeCsvField).join(","));
  return bom + [headerLine, ...dataLines].join("\n");
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportPanel({
  projectId,
  projectName,
  individualHeaders,
  individualRows,
  verdictHeaders,
  verdictRows,
}: ExportPanelProps) {
  const [dataset, setDataset] = useState<"individual" | "verdict" | "both">(
    "individual",
  );
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");

  const currentHeaders =
    dataset === "verdict" ? verdictHeaders : individualHeaders;
  const currentRows =
    dataset === "verdict"
      ? verdictRows
      : dataset === "both"
        ? [...individualRows, ...verdictRows]
        : individualRows;

  const previewRows = currentRows.slice(0, 10);

  const handleDownload = async () => {
    const timestamp = new Date().toISOString().slice(0, 10);
    const suffix =
      dataset === "individual"
        ? "respostas"
        : dataset === "verdict"
          ? "gabarito"
          : "completo";

    if (format === "csv") {
      const headers =
        dataset === "both"
          ? [
              ...individualHeaders,
              ...verdictHeaders.filter(
                (h) => !individualHeaders.includes(h),
              ),
            ]
          : currentHeaders;

      let rows: string[][];
      if (dataset === "both") {
        const padIndividual = individualRows.map((row) => {
          const extraCols = verdictHeaders.filter(
            (h) => !individualHeaders.includes(h),
          );
          return [...row, ...extraCols.map(() => "")];
        });
        const padVerdict = verdictRows.map((row) => {
          const result: string[] = [];
          for (const h of headers) {
            const vi = verdictHeaders.indexOf(h);
            result.push(vi >= 0 ? row[vi] : "");
          }
          return result;
        });
        rows = [...padIndividual, ...padVerdict];
      } else {
        rows = currentRows;
      }

      const csv = buildCsv(headers, rows);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      downloadBlob(blob, `${projectName}-${suffix}-${timestamp}.csv`);
    } else {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();

      if (dataset === "both") {
        const ws1 = XLSX.utils.aoa_to_sheet([
          individualHeaders,
          ...individualRows,
        ]);
        XLSX.utils.book_append_sheet(wb, ws1, "Respostas");
        const ws2 = XLSX.utils.aoa_to_sheet([
          verdictHeaders,
          ...verdictRows,
        ]);
        XLSX.utils.book_append_sheet(wb, ws2, "Gabarito");
      } else {
        const ws = XLSX.utils.aoa_to_sheet([currentHeaders, ...currentRows]);
        XLSX.utils.book_append_sheet(
          wb,
          ws,
          dataset === "individual" ? "Respostas" : "Gabarito",
        );
      }

      const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      downloadBlob(blob, `${projectName}-${suffix}-${timestamp}.xlsx`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-6">
        <div className="space-y-2">
          <p className="text-sm font-medium">Dataset</p>
          <RadioGroup
            value={dataset}
            onValueChange={(v) =>
              setDataset(v as "individual" | "verdict" | "both")
            }
            className="flex gap-4"
          >
            <div className="flex items-center gap-1.5">
              <RadioGroupItem value="individual" id="ds-individual" />
              <Label htmlFor="ds-individual" className="text-sm">
                Respostas individuais
              </Label>
            </div>
            <div className="flex items-center gap-1.5">
              <RadioGroupItem value="verdict" id="ds-verdict" />
              <Label htmlFor="ds-verdict" className="text-sm">
                Gabarito do revisor
              </Label>
            </div>
            <div className="flex items-center gap-1.5">
              <RadioGroupItem value="both" id="ds-both" />
              <Label htmlFor="ds-both" className="text-sm">
                Ambos
              </Label>
            </div>
          </RadioGroup>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Formato</p>
          <RadioGroup
            value={format}
            onValueChange={(v) => setFormat(v as "csv" | "xlsx")}
            className="flex gap-4"
          >
            <div className="flex items-center gap-1.5">
              <RadioGroupItem value="csv" id="fmt-csv" />
              <Label htmlFor="fmt-csv" className="text-sm">
                CSV
              </Label>
            </div>
            <div className="flex items-center gap-1.5">
              <RadioGroupItem value="xlsx" id="fmt-xlsx" />
              <Label htmlFor="fmt-xlsx" className="text-sm">
                XLSX
              </Label>
            </div>
          </RadioGroup>
        </div>

        <Button
          onClick={handleDownload}
          className="bg-brand text-brand-foreground hover:bg-brand/90"
        >
          <Download className="mr-1.5 h-4 w-4" />
          Download
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            Preview ({currentRows.length} linha
            {currentRows.length !== 1 ? "s" : ""})
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b">
                {currentHeaders.map((h) => (
                  <th
                    key={h}
                    className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, i) => (
                <tr key={i} className="border-b last:border-0">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="max-w-48 truncate px-2 py-1.5 whitespace-nowrap"
                      title={cell}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
              {currentRows.length > 10 && (
                <tr>
                  <td
                    colSpan={currentHeaders.length}
                    className="px-2 py-1.5 text-center text-muted-foreground"
                  >
                    ... e mais {currentRows.length - 10} linhas
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
