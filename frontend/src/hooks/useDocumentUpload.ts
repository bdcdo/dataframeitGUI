"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  uploadDocuments,
  checkDuplicates,
  revalidateProjectDocuments,
  type DuplicateMatch,
  type UploadDoc,
  type UploadOptions,
} from "@/actions/documents";
import { md5 } from "@/lib/hash";
import { errorMessage } from "@/lib/utils";
import {
  MAX_CHUNK_BYTES,
  MAX_HASH_CHECK_CONCURRENCY,
  chunkByBytes,
  isPayloadTooLarge,
  mapWithConcurrency,
  utf8Bytes,
} from "@/lib/upload-chunking";

export interface ColumnMapping {
  text: string;
  title: string;
  external_id: string;
}

export interface AnalysisResult {
  docs: UploadDoc[];
  duplicates: DuplicateMatch[];
  duplicatesWithResponses: number;
  matchType: "external_id" | "text_hash";
}

interface Csv {
  rows: Record<string, string>[];
  columns: string[];
}

// The upload flow is one discriminated `phase`: each variant carries exactly the
// data that state needs (analysis carries its result; uploading carries progress),
// so a state like "analysis without a result" is unrepresentable.
export type UploadPhase =
  | { kind: "idle" }
  | { kind: "mapping" }
  | { kind: "checking" }
  | { kind: "analysis"; analysis: AnalysisResult }
  | { kind: "uploading"; current: number; total: number };

// checkDuplicates payload is small (~50B/doc), but we still chunk to bound request size on huge CSVs.
const MAX_HASH_DOCS_PER_CHUNK = 5_000;

const PAYLOAD_TOO_LARGE_MESSAGE =
  "O envio excedeu o limite do servidor. Tente importar menos documentos por vez ou divida o CSV em partes menores.";

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

  const buildDocs = (): UploadDoc[] => {
    if (!csv || !mapping.text) return [];
    return csv.rows
      .filter((row) => row[mapping.text]?.trim())
      .map((row) => ({
        text: row[mapping.text],
        title: mapping.title ? row[mapping.title] : undefined,
        external_id: mapping.external_id ? row[mapping.external_id] : undefined,
      }));
  };

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

        // Localize duplicateMap indices to the chunk so uploadDocuments can index
        // into `items` directly (csvIndex must be relative to the array sent).
        const localOptions: UploadOptions | undefined = options
          ? {
              mode: options.mode,
              deleteResponses: options.deleteResponses,
              duplicateMap: options.duplicateMap
                ?.filter(
                  (d) => d.csvIndex >= startIndex && d.csvIndex < endIndex
                )
                .map((d) => ({ ...d, csvIndex: d.csvIndex - startIndex })),
            }
          : undefined;

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
      const skipped = docs.length - totalInserted;
      // Verbo ciente do modo: em replace_and_add, `count` conta duplicatas
      // ATUALIZADAS (não inseridas), então "importados" sozinho superconta.
      const savedVerb =
        options?.mode === "replace_and_add"
          ? "importado(s)/atualizado(s)"
          : "importado(s)";
      const allVerb =
        options?.mode === "replace_and_add"
          ? "importados/atualizados"
          : "importados";
      toast.success(
        skipped > 0
          ? `${totalInserted} documento(s) ${savedVerb}; ${skipped} ignorado(s) (já existiam no projeto ou repetidos no arquivo).`
          : `${docs.length} documentos ${allVerb}!`
      );
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
      if (totalInserted > 0) {
        // Chunks 0..N-1 já foram commitados; só o último chunk revalidaria.
        const importedVerb =
          options?.mode === "replace_and_add"
            ? "importados/atualizados"
            : "importados";
        // Num replace destrutivo multi-chunk, este ramo (totalInserted > 0) e o
        // ramo `else if (destructiveReplace)` não são exclusivos: um chunk
        // anterior pode ter inserido enquanto o que falhou já apagou
        // responses/reviews. O aviso de remoção precisa ser anexado aqui também,
        // senão ficaria inalcançável justamente no cenário com perda de dados.
        const destructiveWarn = destructiveReplace
          ? " Respostas/revisões de documentos duplicados podem já ter sido removidas — confira a lista."
          : "";
        toast.error(
          isPayloadTooLarge(msg)
            ? `${totalInserted}/${docs.length} ${importedVerb}. ${PAYLOAD_TOO_LARGE_MESSAGE}${destructiveWarn}`
            : `${totalInserted} de ${docs.length} documentos ${importedVerb} antes de uma falha${msg ? `: ${msg}` : ""}${destructiveWarn}`
        );
      } else if (destructiveReplace) {
        toast.error(
          `A importação falhou, mas respostas/revisões dos documentos duplicados podem já ter sido removidas. Confira a lista.${msg ? ` (${msg})` : ""}`
        );
      } else {
        toast.error(
          isPayloadTooLarge(msg)
            ? PAYLOAD_TOO_LARGE_MESSAGE
            : msg || "Erro ao importar documentos"
        );
      }
      setPhase(returnTo);
    }
  };

  const handleCheckAndUpload = async () => {
    const docs = buildDocs();
    if (docs.length === 0) {
      toast.error("Nenhum documento válido encontrado");
      return;
    }

    // Mede os bytes UTF-8 uma única vez: reusado no check de oversize e repassado
    // a chunkByBytes (via doUpload) para não re-encodar todo o array.
    const sizes = docs.map((d) => utf8Bytes(d.text));

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
      // Hash client-side so the request payload stays small (Vercel ~4.5MB limit).
      const docsWithHash = docs.map((d, i) => ({
        external_id: d.external_id,
        text_hash: md5(d.text),
        csvIndex: i,
      }));

      // Chunks are independent and the aggregation below is commutative, so run
      // them concurrently — but bounded, so a huge CSV doesn't fire hundreds of
      // Server Action requests at once.
      const hashChunks: (typeof docsWithHash)[] = [];
      for (let i = 0; i < docsWithHash.length; i += MAX_HASH_DOCS_PER_CHUNK) {
        hashChunks.push(docsWithHash.slice(i, i + MAX_HASH_DOCS_PER_CHUNK));
      }
      const results = await mapWithConcurrency(
        hashChunks,
        MAX_HASH_CHECK_CONCURRENCY,
        (chunk) => checkDuplicates(projectId, chunk)
      );

      const allDuplicates: DuplicateMatch[] = [];
      let duplicatesWithResponses = 0;
      for (const r of results) {
        allDuplicates.push(...r.duplicates);
        duplicatesWithResponses += r.duplicatesWithResponses;
      }

      if (allDuplicates.length === 0) {
        // No duplicates — upload directly; a failure returns to mapping.
        await doUpload(docs, { kind: "mapping" }, undefined, sizes);
      } else {
        // Has duplicates — show analysis panel.
        const hasExternalIdMatch = allDuplicates.some(
          (d) => d.matchType === "external_id"
        );
        setPhase({
          kind: "analysis",
          analysis: {
            docs,
            duplicates: allDuplicates,
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
