"use client";

import { DuplicateAnalysis } from "./DuplicateAnalysis";
import { CsvDropzone } from "./CsvDropzone";
import { MappingStep } from "./MappingStep";
import { useDocumentUpload } from "@/hooks/useDocumentUpload";

interface DocumentUploadProps {
  projectId: string;
}

export function DocumentUpload({ projectId }: DocumentUploadProps) {
  const {
    phase,
    csv,
    mapping,
    setMapping,
    loading,
    handleFile,
    handleCheckAndUpload,
    handleImportNewOnly,
    handleReplaceAndImport,
    handleImportAll,
    cancelAnalysis,
  } = useDocumentUpload(projectId);

  return (
    <div className="space-y-4">
      {phase.kind !== "analysis" && (
        <CsvDropzone onFile={(file) => void handleFile(file)} />
      )}

      {phase.kind === "mapping" && csv && csv.columns.length > 0 && (
        <MappingStep
          rows={csv.rows}
          columns={csv.columns}
          mapping={mapping}
          onMappingChange={setMapping}
          disabled={!mapping.text}
          onSubmit={() => void handleCheckAndUpload()}
        />
      )}

      {phase.kind === "checking" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="size-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          Verificando duplicatas…
        </div>
      )}

      {phase.kind === "analysis" && (
        <DuplicateAnalysis
          totalCount={phase.analysis.docs.length}
          newCount={phase.analysis.docs.length - phase.analysis.duplicates.length}
          duplicateCount={phase.analysis.duplicates.length}
          duplicatesWithResponses={phase.analysis.duplicatesWithResponses}
          matchType={phase.analysis.matchType}
          onImportNewOnly={handleImportNewOnly}
          onReplaceAndImport={handleReplaceAndImport}
          onImportAll={handleImportAll}
          onCancel={cancelAnalysis}
          loading={loading}
        />
      )}

      {phase.kind === "uploading" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="size-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          Importando {phase.current}/{phase.total}...
        </div>
      )}
    </div>
  );
}
