"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getExportDataset } from "@/actions/export";
import type { ExportDataset, ExportSheet } from "@/lib/export/assemble";

// BOM + escaping manual herdados do antigo ExportPanel (comportamento validado
// em produção): garante acentuação correta ao abrir o CSV no Excel.
function escapeCsvField(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function buildCsv(sheet: ExportSheet): string {
  const bom = "﻿"; // BOM: força o Excel a ler o CSV como UTF-8 (acentos).
  const headerLine = sheet.headers.map(escapeCsvField).join(",");
  const dataLines = sheet.rows.map((row) => row.map(escapeCsvField).join(","));
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

// Monta o XLSX com exceljs (import dinâmico — pesado, lazy). Aba Documentos
// sempre presente; Respostas/Gabarito só quando houver linhas.
async function buildXlsxBlob(data: ExportDataset): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const addSheet = (name: string, sheet: ExportSheet) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(sheet.headers);
    ws.addRows(sheet.rows);
  };
  addSheet("Documentos", data.documents);
  if (data.responses.rows.length > 0) addSheet("Respostas", data.responses);
  if (data.verdicts.rows.length > 0) addSheet("Gabarito", data.verdicts);
  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

const PREVIEW_LIMIT = 10;

type ExportFormat = "csv" | "xlsx";

// Controles do card: seletor de formato + botões "Gerar prévia"/"Baixar".
function ExportControls({
  format,
  onFormatChange,
  loading,
  hasDataset,
  isEmpty,
  onPreview,
  onDownload,
}: {
  format: ExportFormat;
  onFormatChange: (f: ExportFormat) => void;
  loading: boolean;
  hasDataset: boolean;
  isEmpty: boolean;
  onPreview: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-6">
      <div className="space-y-2">
        <p className="text-sm font-medium">Formato</p>
        <RadioGroup
          value={format}
          onValueChange={(v) => onFormatChange(v as ExportFormat)}
          className="flex gap-4"
        >
          <div className="flex items-center gap-1.5">
            <RadioGroupItem value="csv" id="export-fmt-csv" />
            <Label htmlFor="export-fmt-csv" className="text-sm">
              CSV
            </Label>
          </div>
          <div className="flex items-center gap-1.5">
            <RadioGroupItem value="xlsx" id="export-fmt-xlsx" />
            <Label htmlFor="export-fmt-xlsx" className="text-sm">
              XLSX
            </Label>
          </div>
        </RadioGroup>
      </div>

      <div className="flex gap-2">
        {!hasDataset && (
          <Button variant="outline" onClick={onPreview} disabled={loading}>
            {loading && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Gerar prévia
          </Button>
        )}
        <Button
          onClick={onDownload}
          disabled={loading || isEmpty}
          className="bg-brand text-brand-foreground hover:bg-brand/90"
        >
          {loading ? (
            <Loader2 className="mr-1.5 size-4 animate-spin" />
          ) : (
            <Download className="mr-1.5 size-4" />
          )}
          Baixar {format.toUpperCase()}
        </Button>
      </div>
    </div>
  );
}

// Tabela de prévia estática (read-only): renderiza os primeiros `limit` registros
// da visão unificada. Extraída para manter o ExportCard enxuto.
function PreviewTable({ sheet, limit }: { sheet: ExportSheet; limit: number }) {
  const preview = sheet.rows.slice(0, limit);
  return (
    <div>
      <p className="mb-2 text-sm font-medium">
        Prévia ({sheet.rows.length} linha{sheet.rows.length !== 1 ? "s" : ""})
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b">
              {sheet.headers.map((h) => (
                <th
                  key={h}
                  className="px-2 py-1.5 text-left font-medium whitespace-nowrap text-muted-foreground"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Prévia estática read-only (slice das linhas): nunca reordena/
                filtra/edita, e as linhas são string[] sem id estável — o índice
                é a chave idiomática correta aqui. */}
            {preview.map((row, i) => (
              // react-doctor-disable-next-line react-doctor/no-array-index-as-key
              <tr key={i} className="border-b last:border-0">
                {row.map((cell, j) => (
                  // react-doctor-disable-next-line react-doctor/no-array-index-as-key
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
            {sheet.rows.length > limit && (
              <tr>
                <td
                  colSpan={sheet.headers.length}
                  className="px-2 py-1.5 text-center text-muted-foreground"
                >
                  ... e mais {sheet.rows.length - limit} linhas
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ExportCard({ projectId }: { projectId: string }) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [dataset, setDataset] = useState<ExportDataset | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Busca o dataset SÓ em interação explícita — nunca no mount — para a página
  // Documentos não pagar o custo (metadata + respostas) em toda visita.
  const loadDataset = async (): Promise<ExportDataset | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await getExportDataset(projectId);
      if ("error" in result) {
        setError(result.error);
        return null;
      }
      setDataset(result);
      return result;
    } catch {
      setError("Não foi possível carregar os dados de exportação.");
      return null;
    } finally {
      setLoading(false);
    }
  };

  const doDownload = async (data: ExportDataset) => {
    const timestamp = new Date().toISOString().slice(0, 10);
    const base = `${data.projectName}-completo-${timestamp}`;
    if (format === "csv") {
      const blob = new Blob([buildCsv(data.csv)], {
        type: "text/csv;charset=utf-8",
      });
      downloadBlob(blob, `${base}.csv`);
      return;
    }
    const blob = await buildXlsxBlob(data);
    downloadBlob(blob, `${base}.xlsx`);
  };

  // Se ainda não há dataset, carrega antes de baixar; senão baixa direto.
  const handleDownload = async () => {
    const data = dataset ?? (await loadDataset());
    if (!data) return;
    try {
      await doDownload(data);
    } catch {
      toast.error("Não foi possível gerar o arquivo de exportação.");
    }
  };

  const isEmpty = dataset !== null && dataset.csv.rows.length === 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Exportar documentos</CardTitle>
        <p className="text-sm text-muted-foreground">
          Baixa o conjunto completo — documentos, respostas individuais e
          gabarito — com as colunas originais de cada documento.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <ExportControls
          format={format}
          onFormatChange={setFormat}
          loading={loading}
          hasDataset={dataset !== null}
          isEmpty={isEmpty}
          onPreview={() => void loadDataset()}
          onDownload={() => void handleDownload()}
        />

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {isEmpty && (
          <p className="text-sm text-muted-foreground">
            Nenhum documento para exportar.
          </p>
        )}

        {dataset !== null && !isEmpty && (
          <PreviewTable sheet={dataset.csv} limit={PREVIEW_LIMIT} />
        )}
      </CardContent>
    </Card>
  );
}
