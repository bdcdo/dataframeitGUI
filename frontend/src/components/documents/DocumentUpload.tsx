"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  uploadDocuments,
  checkDuplicates,
  type DuplicateMatch,
  type UploadOptions,
} from "@/actions/documents";
import { DuplicateAnalysis } from "./DuplicateAnalysis";
import { toast } from "sonner";
import Papa from "papaparse";

interface DocumentUploadProps {
  projectId: string;
}

type UploadStep = "idle" | "mapping" | "checking" | "analysis" | "uploading";

interface AnalysisResult {
  docs: { text: string; title?: string; external_id?: string }[];
  duplicates: DuplicateMatch[];
  duplicatesWithResponses: number;
  matchType: string;
}

export function DocumentUpload({ projectId }: DocumentUploadProps) {
  const [step, setStep] = useState<UploadStep>("idle");
  const [loading, setLoading] = useState(false);
  const [parsedData, setParsedData] = useState<Record<string, string>[] | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState<{ text: string; title: string; external_id: string }>({
    text: "",
    title: "",
    external_id: "",
  });
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);

  const preview = parsedData?.slice(0, 5) ?? null;

  const handleFile = useCallback((file: File) => {
    Papa.parse(file, {
      header: true,
      complete: (results) => {
        const data = results.data as Record<string, string>[];
        setParsedData(data);
        const cols = results.meta.fields || [];
        setColumns(cols);
        setMapping({ text: "", title: "", external_id: "" });
        setStep("mapping");
        setAnalysis(null);
      },
    });
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const buildDocs = () => {
    if (!parsedData || !mapping.text) return [];
    return parsedData
      .filter((row) => row[mapping.text]?.trim())
      .map((row) => ({
        text: row[mapping.text],
        title: mapping.title ? row[mapping.title] : undefined,
        external_id: mapping.external_id ? row[mapping.external_id] : undefined,
      }));
  };

  const doUpload = async (docs: { text: string; title?: string; external_id?: string }[], options?: UploadOptions) => {
    setStep("uploading");
    setLoading(true);
    setProgress({ current: 0, total: docs.length });

    try {
      const chunkSize = 100;
      for (let i = 0; i < docs.length; i += chunkSize) {
        const chunk = docs.slice(i, i + chunkSize);
        const isLast = i + chunkSize >= docs.length;
        // Pass options only on first chunk (duplicateMap indices refer to full array)
        const result = await uploadDocuments(
          projectId,
          chunk,
          isLast,
          i === 0 ? options : { mode: options?.mode ?? "add_all" }
        );
        if (result.error) throw new Error(result.error);
        setProgress({ current: Math.min(i + chunkSize, docs.length), total: docs.length });
      }
      toast.success(`${docs.length} documentos importados!`);
      setParsedData(null);
      setStep("idle");
      setAnalysis(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("Body exceeded") || msg.includes("413")) {
        toast.error("Os documentos ultrapassam o limite de 10 MB por envio. Tente importar um arquivo com menos documentos ou documentos menores.");
      } else {
        toast.error(msg || "Erro ao importar documentos");
      }
      setStep("analysis");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const handleCheckAndUpload = async () => {
    const docs = buildDocs();
    if (docs.length === 0) {
      toast.error("Nenhum documento válido encontrado");
      return;
    }

    setStep("checking");
    setLoading(true);

    try {
      const result = await checkDuplicates(
        projectId,
        docs.map((d) => ({ external_id: d.external_id, text: d.text }))
      );

      if (result.duplicates.length === 0) {
        // No duplicates — upload directly
        await doUpload(docs);
      } else {
        // Has duplicates — show analysis panel
        const hasExternalIdMatch = result.duplicates.some(
          (d) => d.matchType === "external_id"
        );
        setAnalysis({
          docs,
          duplicates: result.duplicates,
          duplicatesWithResponses: result.duplicatesWithResponses,
          matchType: hasExternalIdMatch ? "ID externo" : "conteúdo (hash)",
        });
        setStep("analysis");
        setLoading(false);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("Body exceeded") || msg.includes("413")) {
        toast.error("Os documentos ultrapassam o limite de 10 MB por envio. Tente importar um arquivo com menos documentos ou documentos menores.");
      } else {
        toast.error(msg || "Erro ao verificar duplicatas");
      }
      setStep("mapping");
      setLoading(false);
    }
  };

  const handleImportNewOnly = () => {
    if (!analysis) return;
    doUpload(analysis.docs, {
      mode: "add_new_only",
      duplicateMap: analysis.duplicates,
    });
  };

  const handleReplaceAndImport = (deleteResponses: boolean) => {
    if (!analysis) return;
    doUpload(analysis.docs, {
      mode: "replace_and_add",
      duplicateMap: analysis.duplicates,
      deleteResponses,
    });
  };

  const handleImportAll = () => {
    if (!analysis) return;
    doUpload(analysis.docs, { mode: "add_all" });
  };

  return (
    <div className="space-y-4">
      {step !== "analysis" && (
        <Card
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="border-dashed"
        >
          <CardContent className="flex flex-col items-center gap-2 py-8">
            <p className="text-sm text-muted-foreground">Arraste um CSV ou clique para selecionar</p>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              className="text-sm"
            />
          </CardContent>
        </Card>
      )}

      {step === "mapping" && preview && columns.length > 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-sm font-medium">Coluna de texto *</label>
              <p className="text-xs text-muted-foreground">Conteúdo principal do documento que será analisado pelos pesquisadores</p>
              <select
                value={mapping.text}
                onChange={(e) => setMapping((m) => ({ ...m, text: e.target.value }))}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">Selecione...</option>
                {columns.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Coluna de título</label>
              <p className="text-xs text-muted-foreground">Nome curto para identificar o documento na interface (opcional)</p>
              <select
                value={mapping.title}
                onChange={(e) => setMapping((m) => ({ ...m, title: e.target.value }))}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">Nenhuma</option>
                {columns.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Coluna de ID externo</label>
              <p className="text-xs text-muted-foreground">Identificador do dataset original, ex: número do processo, DOI (opcional)</p>
              <select
                value={mapping.external_id}
                onChange={(e) => setMapping((m) => ({ ...m, external_id: e.target.value }))}
                className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              >
                <option value="">Nenhuma</option>
                {columns.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50">
                  {columns.map((c) => <th key={c} className="px-2 py-1 text-left">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i} className="border-t">
                    {columns.map((c) => <td key={c} className="max-w-xs truncate px-2 py-1">{row[c]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            onClick={handleCheckAndUpload}
            disabled={loading || !mapping.text}
            className="bg-brand hover:bg-brand/90 text-brand-foreground"
          >
            {loading
              ? "Verificando duplicatas..."
              : "Importar"}
          </Button>
        </div>
      )}

      {step === "checking" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          Verificando duplicatas...
        </div>
      )}

      {step === "analysis" && analysis && (
        <DuplicateAnalysis
          totalCount={analysis.docs.length}
          newCount={analysis.docs.length - analysis.duplicates.length}
          duplicateCount={analysis.duplicates.length}
          duplicatesWithResponses={analysis.duplicatesWithResponses}
          matchType={analysis.matchType}
          onImportNewOnly={handleImportNewOnly}
          onReplaceAndImport={handleReplaceAndImport}
          onImportAll={handleImportAll}
          onCancel={() => setStep("mapping")}
          loading={loading}
        />
      )}

      {step === "uploading" && progress && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          Importando {progress.current}/{progress.total}...
        </div>
      )}
    </div>
  );
}
