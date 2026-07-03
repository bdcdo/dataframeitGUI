// Helper de useDocumentUpload que depende de Server Action + hash — por isso
// não vive em lib/upload-chunking.ts, que se mantém puro/testável sem essas
// dependências (ver comentário no topo daquele arquivo).

import { checkDuplicates, type DuplicateMatch, type UploadDoc } from "@/actions/documents";
import { md5 } from "@/lib/hash";
import { MAX_HASH_CHECK_CONCURRENCY, mapWithConcurrency } from "@/lib/upload-chunking";

// checkDuplicates payload is small (~50B/doc), but we still chunk to bound request size on huge CSVs.
const MAX_HASH_DOCS_PER_CHUNK = 5_000;

export async function checkDuplicatesInChunks(
  projectId: string,
  docs: UploadDoc[]
): Promise<{ duplicates: DuplicateMatch[]; duplicatesWithResponses: number }> {
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
  const results = await mapWithConcurrency(hashChunks, MAX_HASH_CHECK_CONCURRENCY, (chunk) =>
    checkDuplicates(projectId, chunk)
  );

  const duplicates: DuplicateMatch[] = [];
  let duplicatesWithResponses = 0;
  for (const r of results) {
    duplicates.push(...r.duplicates);
    duplicatesWithResponses += r.duplicatesWithResponses;
  }
  return { duplicates, duplicatesWithResponses };
}
