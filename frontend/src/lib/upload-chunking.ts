// Pure chunking/sizing helpers for the CSV upload flow, extracted from
// useDocumentUpload so they can be unit-tested without the client hook's
// dependency graph (sonner, Server Actions, md5). No React/client imports here.

// Vercel Server Actions reject payloads above ~4.5 MB (FUNCTION_PAYLOAD_TOO_LARGE).
// Pack docs by aggregate UTF-8 byte size to stay safely under that, with a count cap to avoid latency spikes.
export const MAX_CHUNK_BYTES = 3_500_000;
export const MAX_DOCS_PER_CHUNK = 500;

const textEncoder = new TextEncoder();
export const utf8Bytes = (s: string) => textEncoder.encode(s).length;

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
export function chunkByBytes<T extends { text: string }>(
  docs: T[]
): { items: T[]; startIndex: number }[] {
  const chunks: { items: T[]; startIndex: number }[] = [];
  let current: T[] = [];
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
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
