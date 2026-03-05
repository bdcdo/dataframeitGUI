"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { uploadDocuments } from "@/actions/documents";
import { toast } from "sonner";
import Papa from "papaparse";

interface DocumentUploadProps {
  projectId: string;
}

export function DocumentUpload({ projectId }: DocumentUploadProps) {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<Record<string, string>[] | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState<{ text: string; title: string; external_id: string }>({
    text: "",
    title: "",
    external_id: "",
  });

  const handleFile = useCallback((file: File) => {
    Papa.parse(file, {
      header: true,
      complete: (results) => {
        const data = results.data as Record<string, string>[];
        setPreview(data.slice(0, 5));
        const cols = results.meta.fields || [];
        setColumns(cols);
        setMapping({ text: "", title: "", external_id: "" });
      },
    });
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleUpload = async () => {
    if (!preview || !mapping.text) return;
    setLoading(true);

    try {
      // Re-parse full file would be needed here, using preview for now
      // In production, store the full parsed data
      const file = (document.querySelector('input[type="file"]') as HTMLInputElement)?.files?.[0];
      if (!file) return;

      Papa.parse(file, {
        header: true,
        complete: async (results) => {
          const data = results.data as Record<string, string>[];
          const docs = data
            .filter((row) => row[mapping.text]?.trim())
            .map((row) => ({
              text: row[mapping.text],
              title: mapping.title ? row[mapping.title] : undefined,
              external_id: mapping.external_id ? row[mapping.external_id] : undefined,
            }));

          const result = await uploadDocuments(projectId, docs);
          toast.success(`${result.count} documentos importados!`);
          setPreview(null);
          setLoading(false);
        },
      });
    } catch (e) {
      toast.error("Erro ao importar documentos");
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
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

      {preview && columns.length > 0 && (
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
          <Button onClick={handleUpload} disabled={loading || !mapping.text} className="bg-brand hover:bg-brand/90 text-brand-foreground">
            {loading ? "Importando..." : "Importar"}
          </Button>
        </div>
      )}
    </div>
  );
}
