"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  uploadDocuments,
  revalidateProjectDocuments,
  type DuplicateMatch,
  type UploadDoc,
  type UploadOptions,
} from "@/actions/documents";
import { errorMessage } from "@/lib/utils";
import {
  MAX_CHUNK_BYTES,
  PAYLOAD_TOO_LARGE_MESSAGE,
  buildDocs,
  buildUploadErrorMessage,
  buildUploadSuccessMessage,
  chunkByBytes,
  docBytes,
  isPayloadTooLarge,
  remapDuplicateMapToChunk,
  type ColumnMapping,
  type Csv,
} from "@/lib/upload-chunking";
import { checkDuplicatesInChunks } from "./document-upload-helpers";

// Re-exportado para não quebrar `import type { ColumnMapping } from
// "@/hooks/useDocumentUpload"` em MappingStep.tsx — a definição canônica
// agora vive em lib/upload-chunking.ts, junto de buildDocs (que a consome).
export type { ColumnMapping };

interface AnalysisResult {
  docs: UploadDoc[];
  duplicates: DuplicateMatch[];
  duplicatesWithResponses: number;
  matchType: "external_id" | "text_hash";
}

// The upload flow is one discriminated `phase`: each variant carries exactly the
// data that state needs (analysis carries its result; uploading carries progress),
// so a state like "analysis without a result" is unrepresentable.
type UploadPhase =
  | { kind: "idle" }
  | { kind: "mapping" }
  | { kind: "checking" }
  | { kind: "analysis"; analysis: AnalysisResult }
  | { kind: "uploading"; current: number; total: number };

export function useDocumentUpload(projectId: string) {
  const [phase, setPhase] = useState<UploadPhase>({ kind: "idle" });
  const [csv, setCsv] = useState<Csv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({
    text: "",
    title: "",
    external_id: "",
  });

  // `loading` is derived, not stored: true exactly while a request is in flight
  // (checking/uploading), false in idle/mapping/analysis.
  const loading = phase.kind === "checking" || phase.kind === "uploading";

  const handleFile = useCallback(async (file: File) => {
    const Papa = (await import("papaparse")).default;
    Papa.parse(file, {
      header: true,
      complete: (results) => {
        // PapaParse é tolerante: popula `errors` em problemas recuperáveis
        // (aspas, contagem de campos) mas ainda devolve linhas. Avisa e segue —
        // linhas parciais costumam ser mapeáveis.
        if (results.errors?.length) {
          console.warn("[useDocumentUpload] Papa.parse avisos", results.errors);
          toast.warning(
            `CSV lido com ${results.errors.length} aviso(s) de parsing; confira as linhas afetadas.`
          );
        }
        const rows = results.data as Record<string, string>[];
        const columns = results.meta.fields || [];
        setCsv({ rows, columns });
        setMapping({ text: "", title: "", external_id: "" });
        setPhase({ kind: "mapping" });
      },
      // Erro fatal de leitura/parsing: aborta sem sair de `idle` (a dropzone
      // continua visível para nova tentativa).
      error: (err) => {
        console.error("[useDocumentUpload] Papa.parse falhou", err);
        toast.error(`Não foi possível ler o CSV: ${err.message}`);
      },
    });
  }, []);

  // `returnTo` is the phase to restore if the upload fails, so a failure on the
  // no-duplicates path lands back on mapping (retryable) instead of a blank panel.
  const doUpload = async (
    docs: UploadDoc[],
    returnTo: UploadPhase,
    options?: UploadOptions,
    // Bytes UTF-8 por doc já medidos pelo chamador (handleCheckAndUpload mede uma
    // vez no check de oversize); repassados a chunkByBytes para não re-encodar.
    sizes?: number[]
  ) => {
    setPhase({ kind: "uploading", current: 0, total: docs.length });

    // Hoisted out of the try so the catch can revalidate/report based on how many
    // docs landed before a failure (count-based, como o caminho de sucesso).
    let processed = 0;
    let totalInserted = 0;
    try {
      const chunks = chunkByBytes(docs, sizes);
      for (let ci = 0; ci < chunks.length; ci++) {
        const { items, startIndex } = chunks[ci];
        const endIndex = startIndex + items.length;
        const isLast = ci === chunks.length - 1;

        const localOptions = remapDuplicateMapToChunk(options, startIndex, endIndex);

        // Serial on purpose: progress is reported sequentially, and `isLast` is the
        // `revalidate` arg — true only on the last chunk revalidates the documents
        // cache once instead of once per chunk. Parallelizing would break both.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const result = await uploadDocuments(
          projectId,
          items,
          isLast,
          localOptions
        );
        if (result.error) throw new Error(result.error);
        // `count` is the rows actually inserted this chunk (< items in
        // add_new_only, where duplicates are skipped server-side).
        totalInserted += result.count ?? 0;
        processed += items.length;
        setPhase({ kind: "uploading", current: processed, total: docs.length });
      }
      toast.success(buildUploadSuccessMessage(totalInserted, docs.length, options?.mode));
      setCsv(null);
      setPhase({ kind: "idle" });
    } catch (e) {
      console.error("[useDocumentUpload] doUpload falhou", e);
      const msg = errorMessage(e);
      const destructiveReplace =
        options?.mode === "replace_and_add" && !!options?.deleteResponses;
      // Revalida sempre que o banco pode ter mudado: algo entrou (totalInserted > 0)
      // ou um replace destrutivo já pode ter apagado responses/reviews mesmo sem
      // inserção. Guarda: revalidateProjectDocuments é Server Action e pode rejeitar
      // no transporte — sem o try, setPhase(returnTo) abaixo não rodaria (UI presa).
      if (totalInserted > 0 || destructiveReplace) {
        try {
          await revalidateProjectDocuments(projectId);
        } catch (revalErr) {
          console.error("[useDocumentUpload] revalidate no catch falhou", revalErr);
        }
      }
      toast.error(
        buildUploadErrorMessage({
          totalInserted,
          totalDocs: docs.length,
          mode: options?.mode,
          deleteResponses: options?.deleteResponses,
          msg,
        })
      );
      setPhase(returnTo);
    }
  };

  const handleCheckAndUpload = async () => {
    const docs = buildDocs(csv, mapping);
    if (docs.length === 0) {
      toast.error("Nenhum documento válido encontrado");
      return;
    }

    // Mede os bytes UTF-8 do doc serializado completo (inclui metadata) uma única
    // vez: reusado no check de oversize e repassado a chunkByBytes (via doUpload)
    // para não re-encodar. Medir só o texto subestimaria o payload real (a linha
    // original preservada quase dobra o tamanho por doc — ver docBytes).
    const sizes = docs.map(docBytes);

    // Fail early if a single doc exceeds the per-chunk byte budget — chunking can't rescue it.
    const oversizeIdx = sizes.findIndex((b) => b > MAX_CHUNK_BYTES);
    if (oversizeIdx !== -1) {
      const sizeMb = (sizes[oversizeIdx] / 1_000_000).toFixed(2);
      const limitMb = (MAX_CHUNK_BYTES / 1_000_000).toFixed(1);
      toast.error(
        `Documento na linha ${oversizeIdx + 1} tem ${sizeMb} MB, acima do limite de ${limitMb} MB por documento. Remova-o ou divida o texto antes de importar.`
      );
      return;
    }

    setPhase({ kind: "checking" });

    try {
      const { duplicates, duplicatesWithResponses } = await checkDuplicatesInChunks(
        projectId,
        docs
      );

      if (duplicates.length === 0) {
        // No duplicates — upload directly; a failure returns to mapping.
        await doUpload(docs, { kind: "mapping" }, undefined, sizes);
      } else {
        // Has duplicates — show analysis panel.
        const hasExternalIdMatch = duplicates.some(
          (d) => d.matchType === "external_id"
        );
        setPhase({
          kind: "analysis",
          analysis: {
            docs,
            duplicates,
            duplicatesWithResponses,
            matchType: hasExternalIdMatch ? "external_id" : "text_hash",
          },
        });
      }
    } catch (e) {
      console.error("[useDocumentUpload] handleCheckAndUpload falhou", e);
      const msg = errorMessage(e);
      toast.error(
        isPayloadTooLarge(msg)
          ? PAYLOAD_TOO_LARGE_MESSAGE
          : msg || "Erro ao verificar duplicatas"
      );
      setPhase({ kind: "mapping" });
    }
  };

  // The three analysis actions return to the analysis panel on a failed upload.
  const handleImportNewOnly = () => {
    if (phase.kind !== "analysis") return;
    const { analysis } = phase;
    void doUpload(analysis.docs, phase, {
      mode: "add_new_only",
      duplicateMap: analysis.duplicates,
    });
  };

  const handleReplaceAndImport = (deleteResponses: boolean) => {
    if (phase.kind !== "analysis") return;
    const { analysis } = phase;
    void doUpload(analysis.docs, phase, {
      mode: "replace_and_add",
      duplicateMap: analysis.duplicates,
      deleteResponses,
    });
  };

  const handleImportAll = () => {
    if (phase.kind !== "analysis") return;
    const { analysis } = phase;
    void doUpload(analysis.docs, phase, { mode: "add_all" });
  };

  const cancelAnalysis = () => setPhase({ kind: "mapping" });

  return {
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
  };
}
