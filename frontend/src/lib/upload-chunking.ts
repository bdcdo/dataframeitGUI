// Pure chunking/sizing helpers for the CSV upload flow, extracted from
// useDocumentUpload so they can be unit-tested without the client hook's
// dependency graph (sonner, Server Actions, md5). No React/client imports here.
//
// checkDuplicatesInChunks (que chama a Server Action checkDuplicates) fica de
// propósito FORA deste módulo — mora em hooks/document-upload-helpers.ts — para
// preservar essa ausência de dependência de Server Actions/React aqui.

import type { UploadDoc, UploadOptions } from "@/actions/documents";

export interface ColumnMapping {
  text: string;
  title: string;
  external_id: string;
}

export interface Csv {
  rows: Record<string, string>[];
  columns: string[];
}

export const PAYLOAD_TOO_LARGE_MESSAGE =
  "O envio excedeu o limite do servidor. Tente importar menos documentos por vez ou divida o CSV em partes menores.";

// Vercel Server Actions reject payloads above ~4.5 MB (FUNCTION_PAYLOAD_TOO_LARGE).
// Pack docs by aggregate UTF-8 byte size to stay safely under that, with a count cap to avoid latency spikes.
export const MAX_CHUNK_BYTES = 3_500_000;
export const MAX_DOCS_PER_CHUNK = 500;

const textEncoder = new TextEncoder();
export const utf8Bytes = (s: string) => textEncoder.encode(s).length;

// Bytes UTF-8 do documento serializado completo (text + title + external_id +
// metadata), não apenas do texto. A linha original preservada em metadata pode
// quase dobrar o payload por doc (o texto aparece em `text` e de novo em
// original_row[colunaDeTexto]); medir só o texto subestimaria o payload e um
// chunk "dentro do limite" estouraria o cap ~4,5 MB de Server Actions da Vercel.
// Fonte única da medição — usada tanto no chunking quanto no fail-early do hook.
export const docBytes = (doc: UploadDoc) => utf8Bytes(JSON.stringify(doc));

export function isPayloadTooLarge(msg: string): boolean {
  return (
    msg.includes("Body exceeded") ||
    msg.includes("413") ||
    msg.includes("FUNCTION_PAYLOAD_TOO_LARGE")
  );
}

// Generic over `{ text: string }` so the lib stays decoupled from UploadDoc.
// `startIndex` is the position of each chunk's first item in the original
// array — the caller uses it to re-base per-chunk indices (e.g. duplicateMap).
// `sizes` (opcional) são os bytes UTF-8 por doc já medidos pelo chamador (o hook
// mede uma vez para o check de oversize); evita re-encodar todo o array aqui.
// Sem `sizes`, encoda sob demanda — mantém a API pura testável isoladamente.
export function chunkByBytes<T extends { text: string }>(
  docs: T[],
  sizes?: number[]
): { items: T[]; startIndex: number }[] {
  const chunks: { items: T[]; startIndex: number }[] = [];
  let current: T[] = [];
  let currentBytes = 0;
  let startIndex = 0;
  for (let i = 0; i < docs.length; i++) {
    const itemBytes = sizes ? sizes[i] : docBytes(docs[i] as UploadDoc);
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

// Browsers cap concurrent connections to one host at ~6; firing every chunk at
// once (Promise.all) on a huge CSV would queue the excess in the browser anyway
// and pile load on the server. Bound in-flight work to this many at a time.
export const MAX_HASH_CHECK_CONCURRENCY = 6;

// Like `Promise.all(items.map(fn))` but with at most `limit` calls in flight at
// once. Results are written by position, so the returned array mirrors `items`
// order regardless of which calls settle first. Rejects on the first rejection
// (matching Promise.all), leaving outstanding workers to settle unobserved.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      // O await em loop é o núcleo deste helper de concorrência limitada: cada
      // worker processa itens em série; o paralelismo vem dos N workers. O
      // Promise.all que a regra sugeriria é justamente o que estamos limitando.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

export function buildDocs(csv: Csv | null, mapping: ColumnMapping): UploadDoc[] {
  if (!csv || !mapping.text) return [];
  return csv.rows
    .filter((row) => row[mapping.text]?.trim())
    .map((row) => ({
      text: row[mapping.text],
      title: mapping.title ? row[mapping.title] : undefined,
      external_id: mapping.external_id ? row[mapping.external_id] : undefined,
      // Linha original completa preservada (feature 004): TODA coluna do CSV,
      // inclusive as mapeadas para text/title/external_id (FR-002). Célula
      // ausente numa linha curta normaliza para "" — a coluna existe sem valor.
      // original_columns preserva a ordem do CSV (jsonb não preserva ordem de
      // chaves); os cabeçalhos já chegam únicos do papaparse (ver data-model §1).
      metadata: {
        original_row: Object.fromEntries(
          csv.columns.map((col) => [col, row[col] ?? ""])
        ),
        original_columns: csv.columns,
      },
    }));
}

// Localiza os indices de duplicateMap ao chunk, para que uploadDocuments
// indexe direto em `items` (csvIndex precisa ser relativo ao array enviado).
export function remapDuplicateMapToChunk(
  options: UploadOptions | undefined,
  startIndex: number,
  endIndex: number
): UploadOptions | undefined {
  if (!options) return undefined;
  return {
    mode: options.mode,
    deleteResponses: options.deleteResponses,
    duplicateMap: options.duplicateMap
      ?.filter((d) => d.csvIndex >= startIndex && d.csvIndex < endIndex)
      .map((d) => ({ ...d, csvIndex: d.csvIndex - startIndex })),
  };
}

export function buildUploadSuccessMessage(
  totalInserted: number,
  totalDocs: number,
  mode: UploadOptions["mode"] | undefined
): string {
  const skipped = totalDocs - totalInserted;
  // Verbo ciente do modo: em replace_and_add, `count` conta duplicatas
  // ATUALIZADAS (não inseridas), então "importados" sozinho superconta.
  const savedVerb =
    mode === "replace_and_add" ? "importado(s)/atualizado(s)" : "importado(s)";
  const allVerb = mode === "replace_and_add" ? "importados/atualizados" : "importados";
  return skipped > 0
    ? `${totalInserted} documento(s) ${savedVerb}; ${skipped} ignorado(s) (já existiam no projeto ou repetidos no arquivo).`
    : `${totalDocs} documentos ${allVerb}!`;
}

export function buildUploadErrorMessage(params: {
  totalInserted: number;
  totalDocs: number;
  mode: UploadOptions["mode"] | undefined;
  deleteResponses: boolean | undefined;
  msg: string;
}): string {
  const { totalInserted, totalDocs, mode, deleteResponses, msg } = params;
  const destructiveReplace = mode === "replace_and_add" && !!deleteResponses;

  if (totalInserted > 0) {
    // Chunks 0..N-1 já foram commitados; só o último chunk revalidaria.
    const importedVerb = mode === "replace_and_add" ? "importados/atualizados" : "importados";
    // Num replace destrutivo multi-chunk, este ramo (totalInserted > 0) e o
    // ramo `else if (destructiveReplace)` não são exclusivos: um chunk
    // anterior pode ter inserido enquanto o que falhou já apagou
    // responses/reviews. O aviso de remoção precisa ser anexado aqui também,
    // senão ficaria inalcançável justamente no cenário com perda de dados.
    const destructiveWarn = destructiveReplace
      ? " Respostas/revisões de documentos duplicados podem já ter sido removidas — confira a lista."
      : "";
    return isPayloadTooLarge(msg)
      ? `${totalInserted}/${totalDocs} ${importedVerb}. ${PAYLOAD_TOO_LARGE_MESSAGE}${destructiveWarn}`
      : `${totalInserted} de ${totalDocs} documentos ${importedVerb} antes de uma falha${msg ? `: ${msg}` : ""}${destructiveWarn}`;
  }
  if (destructiveReplace) {
    return `A importação falhou, mas respostas/revisões dos documentos duplicados podem já ter sido removidas. Confira a lista.${msg ? ` (${msg})` : ""}`;
  }
  return isPayloadTooLarge(msg) ? PAYLOAD_TOO_LARGE_MESSAGE : msg || "Erro ao importar documentos";
}
