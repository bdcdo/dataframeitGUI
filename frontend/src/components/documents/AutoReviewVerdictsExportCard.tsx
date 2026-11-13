"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getAutoReviewVerdicts } from "@/actions/auto-review-export";
import { formatDateForFilename } from "@/lib/date-format";
import { downloadBlob } from "@/lib/download-blob";
import { ExportOption } from "@/components/documents/ExportOption";
import {
  AUTO_REVIEW_COLUMN_WIDTHS,
  AUTO_REVIEW_VERDICTS,
  DEFAULT_AUTO_REVIEW_VERDICTS,
  SELF_VERDICT_SHORT_LABELS,
  buildAutoReviewVerdictSheets,
  type AutoReviewReviewer,
  type AutoReviewVerdictData,
  type AutoReviewVerdictSheets,
} from "@/lib/export/auto-review-verdicts";
import type { SelfVerdict } from "@/lib/types";

const ALL_REVIEWERS = "__all__";
const HEADER_FILL = "FF2F6868"; // brand teal

// XLSX com exceljs (import dinâmico, pesado), com o acabamento do script:
// cabeçalho na cor da marca, quebra de linha, painel congelado e autofiltro.
async function buildXlsxBlob(sheets: AutoReviewVerdictSheets): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  const review = wb.addWorksheet("Para revisar", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 1 }],
  });
  review.columns = sheets.review.headers.map((header) => ({
    header,
    width: AUTO_REVIEW_COLUMN_WIDTHS[header],
  }));
  review.addRows(sheets.review.rows);
  review.eachRow((row) => {
    row.alignment = { wrapText: true, vertical: "top" };
  });
  // Por célula: estilo na linha (Row.fill) pinta a linha inteira no Excel,
  // muito além da última coluna.
  review.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  });
  review.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1 + sheets.review.rows.length, column: sheets.review.headers.length },
  };

  const summary = wb.addWorksheet("Resumo");
  summary.addRow(sheets.summary.headers).font = { bold: true };
  summary.addRows(sheets.summary.rows.map(([name, ...counts]) => [name, ...counts.map(Number)]));
  summary.getColumn(1).width = 40;

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// O botão fica desabilitado sem linha, então aqui sempre há o que baixar.
async function downloadSheets(sheets: AutoReviewVerdictSheets, projectName: string) {
  try {
    const blob = await buildXlsxBlob(sheets);
    const timestamp = formatDateForFilename(new Date());
    downloadBlob(blob, `${projectName}-vereditos-auto-revisao-${timestamp}.xlsx`);
  } catch {
    toast.error("Não foi possível gerar a planilha.");
  }
}

function VerdictFilter({
  verdicts,
  onChange,
}: {
  verdicts: SelfVerdict[];
  onChange: (verdicts: SelfVerdict[]) => void;
}) {
  const toggle = (verdict: SelfVerdict, checked: boolean) =>
    onChange(checked ? [...verdicts, verdict] : verdicts.filter((v) => v !== verdict));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Vereditos</legend>
      <div className="flex flex-wrap gap-4">
        {AUTO_REVIEW_VERDICTS.map((verdict) => (
          <div key={verdict} className="flex items-center gap-1.5">
            <Checkbox
              id={`auto-review-verdict-${verdict}`}
              checked={verdicts.includes(verdict)}
              onCheckedChange={(v) => toggle(verdict, v === true)}
            />
            <Label htmlFor={`auto-review-verdict-${verdict}`} className="text-sm">
              {SELF_VERDICT_SHORT_LABELS[verdict]}
            </Label>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function DownloadControls({
  reviewers,
  reviewerId,
  onReviewerChange,
  rowCount,
  loading,
  onReload,
  onDownload,
}: {
  reviewers: AutoReviewReviewer[];
  reviewerId: string;
  onReviewerChange: (id: string) => void;
  rowCount: number;
  loading: boolean;
  onReload: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-6">
      <div className="space-y-2">
        <Label htmlFor="auto-review-reviewer" className="text-sm font-medium">
          Pesquisador
        </Label>
        <Select value={reviewerId} onValueChange={onReviewerChange}>
          <SelectTrigger id="auto-review-reviewer" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_REVIEWERS}>Todos</SelectItem>
            {reviewers.map((reviewer) => (
              <SelectItem key={reviewer.id} value={reviewer.id}>
                {reviewer.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {rowCount} linha{rowCount === 1 ? "" : "s"}
      </p>
      {/* Uma arbitragem feita depois da carga só entra recarregando. */}
      <Button variant="outline" onClick={onReload} disabled={loading}>
        {loading && <Loader2 className="mr-1.5 size-4 animate-spin" />}
        Recarregar
      </Button>
      <Button
        onClick={onDownload}
        disabled={loading || rowCount === 0}
        className="bg-brand text-brand-foreground hover:bg-brand/90"
      >
        <Download className="mr-1.5 size-4" />
        Baixar XLSX
      </Button>
    </div>
  );
}

// Planilha dos vereditos da auto-revisão para o "último filtro" do
// coordenador. Só aparece em projetos `auto_review_llm`
// (ver AutoReviewVerdictsExport). Veredito e pesquisador filtram no cliente,
// sobre os ciclos já carregados.
export function AutoReviewVerdictsExportCard({ projectId }: { projectId: string }) {
  const [verdicts, setVerdicts] = useState<SelfVerdict[]>([...DEFAULT_AUTO_REVIEW_VERDICTS]);
  const [reviewerId, setReviewerId] = useState<string>(ALL_REVIEWERS);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [data, setData] = useState<AutoReviewVerdictData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sheets = useMemo(
    () =>
      data &&
      buildAutoReviewVerdictSheets(data, {
        verdicts,
        reviewerId: reviewerId === ALL_REVIEWERS ? null : reviewerId,
        includeArchived,
      }),
    [data, verdicts, reviewerId, includeArchived],
  );

  // Busca só em interação explícita, nunca no mount: a página Documentos não
  // paga a leitura dos ciclos em toda visita.
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAutoReviewVerdicts(projectId, { includeArchived });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setData(result);
      // O pesquisador escolhido pode não ter ciclo na carga nova.
      setReviewerId((current) =>
        result.reviewers.some((reviewer) => reviewer.id === current) ? current : ALL_REVIEWERS,
      );
    } catch {
      setError("Não foi possível carregar os vereditos da auto-revisão.");
    } finally {
      setLoading(false);
    }
  };

  const changeArchived = (checked: boolean) => {
    setIncludeArchived(checked);
    setData(null);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Exportar vereditos da auto-revisão</CardTitle>
        <p className="text-sm text-muted-foreground">
          Uma linha por célula em que o pesquisador revisou a divergência com o
          LLM, com as duas respostas, as justificativas e a decisão da
          arbitragem, e colunas vazias para a nova decisão. Inclui a aba
          &quot;Resumo&quot; por pergunta.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <VerdictFilter verdicts={verdicts} onChange={setVerdicts} />
        {/* Mudar a opção recarrega: os ciclos arquivados só vêm do banco quando pedidos. */}
        <ExportOption
          id="auto-review-include-archived"
          label="Incluir ciclos que não valem mais"
          help={"Ciclos arquivados (resposta ou pergunta alterada). O veredito deles foi dado sobre outra versão; a coluna \"Situação\" diz o motivo."}
          checked={includeArchived}
          disabled={loading}
          onCheckedChange={changeArchived}
        />

        {data && sheets ? (
          <DownloadControls
            reviewers={data.reviewers}
            reviewerId={reviewerId}
            onReviewerChange={setReviewerId}
            rowCount={sheets.review.rows.length}
            loading={loading}
            onReload={() => void load()}
            onDownload={() => void downloadSheets(sheets, data.projectName)}
          />
        ) : (
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            {loading && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Carregar vereditos
          </Button>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
