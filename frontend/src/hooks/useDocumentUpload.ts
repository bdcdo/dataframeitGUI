"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  uploadDocuments,
  checkDuplicates,
  type DuplicateMatch,
  type UploadOptions,
} from "@/actions/documents";
import { md5 } from "@/lib/hash";

export interface UploadDoc {
  text: string;
  title?: string;
  external_id?: string;
}

export interface ColumnMapping {
  text: string;
  title: string;
  external_id: string;
}

export interface AnalysisResult {
  docs: UploadDoc[];
  duplicates: DuplicateMatch[];
  duplicatesWithResponses: number;
  matchType: string;
}

interface Csv {
  rows: Record<string, string>[];
  columns: string[];
}

// One discriminated `phase` replaces the old step/progress/analysis cluster that
// was set across several handlers (the trigger for react-doctor/prefer-useReducer).
export type UploadPhase =
  | { kind: "idle" }
  | { kind: "mapping" }
  | { kind: "checking" }
  | { kind: "analysis"; analysis: AnalysisResult }
  | { kind: "uploading"; current: number; total: number };

// Vercel Server Actions reject payloads above ~4.5 MB (FUNCTION_PAYLOAD_TOO_LARGE).
// Pack docs by aggregate UTF-8 byte size to stay safely under that, with a count cap to avoid latency spikes.
const MAX_CHUNK_BYTES = 3_500_000;
const MAX_DOCS_PER_CHUNK = 500;
// checkDuplicates payload is small (~50B/doc), but we still chunk to bound request size on huge CSVs.
const MAX_HASH_DOCS_PER_CHUNK = 5_000;

const textEncoder = new TextEncoder();
const utf8Bytes = (s: string) => textEncoder.encode(s).length;

function isPayloadTooLarge(msg: string): boolean {
  return (
    msg.includes("Body exceeded") ||
    msg.includes("413") ||
    msg.includes("FUNCTION_PAYLOAD_TOO_LARGE")
  );
}

function chunkByBytes(
  docs: UploadDoc[]
): { items: UploadDoc[]; startIndex: number }[] {
  const chunks: { items: UploadDoc[]; startIndex: number }[] = [];
  let current: UploadDoc[] = [];
  let currentBytes = 0;
  let startIndex = 0;
  for (let i = 0; i < docs.length; i++) {
    const itemBytes = utf8Bytes(docs[i].text);
    if (
      current.length > 0 &&
      (currentBytes + itemBytes > MAX_CHUNK_BYTES ||
        current.length >= MAX_DOCS_PER_CHUNK)
    ) {
      chunks.push({ items: current, startIndex });
      current = [];
      currentBytes = 0;
      startIndex = i;
    }
    current.push(docs[i]);
    currentBytes += itemBytes;
  }
  if (current.length > 0) chunks.push({ items: current, startIndex });
  return chunks;
}

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

  // `loading` is fully derived: every legacy setLoading(true) was batched with a
  // step into checking/uploading, so it is never true in idle/mapping/analysis.
  const loading = phase.kind === "checking" || phase.kind === "uploading";

  const handleFile = useCallback(async (file: File) => {
    const Papa = (await import("papaparse")).default;
    Papa.parse(file, {
      header: true,
      complete: (results) => {
        const rows = results.data as Record<string, string>[];
        const columns = results.meta.fields || [];
        setCsv({ rows, columns });
        setMapping({ text: "", title: "", external_id: "" });
        setPhase({ kind: "mapping" });
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
    options?: UploadOptions
  ) => {
    setPhase({ kind: "uploading", current: 0, total: docs.length });

    try {
      const chunks = chunkByBytes(docs);
      let processed = 0;
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

        // Serial on purpose: `isLast` tells the backend to finalize on the last
        // chunk and progress is reported sequentially. Parallelizing would break both.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const result = await uploadDocuments(
          projectId,
          items,
          isLast,
          localOptions
        );
        if (result.error) throw new Error(result.error);
        processed += items.length;
        setPhase({ kind: "uploading", current: processed, total: docs.length });
      }
      toast.success(`${docs.length} documentos importados!`);
      setCsv(null);
      setPhase({ kind: "idle" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      toast.error(
        isPayloadTooLarge(msg)
          ? PAYLOAD_TOO_LARGE_MESSAGE
          : msg || "Erro ao importar documentos"
      );
      setPhase(returnTo);
    }
  };

  const handleCheckAndUpload = async () => {
    const docs = buildDocs();
    if (docs.length === 0) {
      toast.error("Nenhum documento válido encontrado");
      return;
    }

    // Fail early if a single doc exceeds the per-chunk byte budget — chunking can't rescue it.
    const oversizeIdx = docs.findIndex((d) => utf8Bytes(d.text) > MAX_CHUNK_BYTES);
    if (oversizeIdx !== -1) {
      const sizeMb = (utf8Bytes(docs[oversizeIdx].text) / 1_000_000).toFixed(2);
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
      // them together instead of awaiting one at a time.
      const hashChunks: (typeof docsWithHash)[] = [];
      for (let i = 0; i < docsWithHash.length; i += MAX_HASH_DOCS_PER_CHUNK) {
        hashChunks.push(docsWithHash.slice(i, i + MAX_HASH_DOCS_PER_CHUNK));
      }
      const results = await Promise.all(
        hashChunks.map((chunk) => checkDuplicates(projectId, chunk))
      );

      const allDuplicates: DuplicateMatch[] = [];
      let duplicatesWithResponses = 0;
      for (const r of results) {
        allDuplicates.push(...r.duplicates);
        duplicatesWithResponses += r.duplicatesWithResponses;
      }

      if (allDuplicates.length === 0) {
        // No duplicates — upload directly; a failure returns to mapping.
        await doUpload(docs, { kind: "mapping" });
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
            matchType: hasExternalIdMatch ? "ID externo" : "conteúdo (hash)",
          },
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
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
    doUpload(analysis.docs, phase, {
      mode: "add_new_only",
      duplicateMap: analysis.duplicates,
    });
  };

  const handleReplaceAndImport = (deleteResponses: boolean) => {
    if (phase.kind !== "analysis") return;
    const { analysis } = phase;
    doUpload(analysis.docs, phase, {
      mode: "replace_and_add",
      duplicateMap: analysis.duplicates,
      deleteResponses,
    });
  };

  const handleImportAll = () => {
    if (phase.kind !== "analysis") return;
    const { analysis } = phase;
    doUpload(analysis.docs, phase, { mode: "add_all" });
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
