"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface DuplicateAnalysisProps {
  totalCount: number;
  newCount: number;
  duplicateCount: number;
  duplicatesWithResponses: number;
  matchType: string;
  onImportNewOnly: () => void;
  onReplaceAndImport: (deleteResponses: boolean) => void;
  onImportAll: () => void;
  onCancel: () => void;
  loading: boolean;
}

export function DuplicateAnalysis({
  totalCount,
  newCount,
  duplicateCount,
  duplicatesWithResponses,
  matchType,
  onImportNewOnly,
  onReplaceAndImport,
  onImportAll,
  onCancel,
  loading,
}: DuplicateAnalysisProps) {
  const [showResponseWarning, setShowResponseWarning] = useState(false);
  const [deleteResponses, setDeleteResponses] = useState(false);

  const handleReplace = () => {
    if (duplicatesWithResponses > 0 && !showResponseWarning) {
      setShowResponseWarning(true);
      return;
    }
    onReplaceAndImport(deleteResponses);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Duplicatas detectadas</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {totalCount} documentos no CSV &mdash;{" "}
          <span className="font-medium text-foreground">{newCount} novos</span>,{" "}
          <span className="font-medium text-foreground">
            {duplicateCount} já existem
          </span>{" "}
          (detectados por {matchType}).
        </p>

        {showResponseWarning && duplicatesWithResponses > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
              {duplicatesWithResponses} documento(s) duplicado(s) possuem
              respostas de codificação.
            </p>
            <div className="mt-2 space-y-1.5">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="responseAction"
                  checked={!deleteResponses}
                  onChange={() => setDeleteResponses(false)}
                />
                Manter respostas existentes
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="responseAction"
                  checked={deleteResponses}
                  onChange={() => setDeleteResponses(true)}
                />
                Apagar respostas e exigir re-codificação
              </label>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {newCount > 0 && (
            <Button
              onClick={onImportNewOnly}
              disabled={loading}
              className="bg-brand hover:bg-brand/90 text-brand-foreground"
            >
              {loading ? "Importando..." : `Importar apenas novos (${newCount})`}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleReplace}
            disabled={loading}
          >
            {loading
              ? "Importando..."
              : `Substituir duplicatas e importar novos`}
          </Button>
          <Button variant="ghost" onClick={onImportAll} disabled={loading}>
            {loading ? "Importando..." : `Importar todos (${totalCount})`}
          </Button>
        </div>

        <Button variant="ghost" size="sm" onClick={onCancel} disabled={loading}>
          &larr; Voltar ao mapeamento
        </Button>
      </CardContent>
    </Card>
  );
}
