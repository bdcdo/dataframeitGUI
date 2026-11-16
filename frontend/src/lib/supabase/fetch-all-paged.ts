import { mapWithConcurrency } from "@/lib/upload-chunking";

// Paginação de leitura do PostgREST. O builder é de uso único (o await o
// executa), por isso o caller passa uma FÁBRICA de query, não a query pronta.
//
// Usado nas leituras que ainda exigem OFFSET; o cursor abaixo atende leituras
// cuja chave de ordenação faz parte do contrato da linha.
// Ambos evitam o teto default de 1000 linhas do PostgREST.
//
// `orderBy` é obrigatório e a assinatura exige pelo menos uma coluna porque
// `.range()` pagina por LIMIT/OFFSET: sem ORDER BY o Postgres não promete ordem
// nenhuma ENTRE statements, e uma troca de plano ou uma escrita concorrente
// entre duas páginas pode reemitir uma linha da página anterior e omitir outra.
// Omitir uma linha aqui não é perder uma linha: na métrica, a resposta LLM
// `is_latest` que sumir tira o documento inteiro do numerador E do denominador.
// A ordem aplicada precisa ser TOTAL — as colunas passadas têm que desempatar
// até a última linha, tipicamente a PK.
export const PAGE_SIZE = 1000;

interface PagedQueryBuilder<T> {
  order: (column: string) => PagedQueryBuilder<T>;
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}

export async function fetchAllPaged<T>(
  build: () => PagedQueryBuilder<T>,
  orderBy: readonly [string, ...string[]],
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const query = orderBy.reduce<PagedQueryBuilder<T>>(
      (acc, column) => acc.order(column),
      build(),
    );
    // await sequencial é da natureza da paginação: só dá para pedir a próxima
    // página sabendo que a anterior veio cheia.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) return { data: all, error };
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { data: all, error: null };
}

// Chaves que pertencem ao contrato das linhas lidas por cursor.
// O cursor evita que INSERT/DELETE antes da página seguinte desloque o OFFSET;
// cada página ainda é um statement separado, sem snapshot transacional (para as
// respostas vigentes, ver `fetch-latest-responses.ts`).
export interface CursorQueryBuilder<T> extends PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
  order: (column: string) => CursorQueryBuilder<T>;
  limit: (count: number) => CursorQueryBuilder<T>;
  gt: (column: string, value: string) => CursorQueryBuilder<T>;
  or: (filters: string) => CursorQueryBuilder<T>;
}

async function fetchAllByCursor<T>(
  build: () => CursorQueryBuilder<T>,
  ordered: (query: CursorQueryBuilder<T>) => CursorQueryBuilder<T>,
  after: (query: CursorQueryBuilder<T>, last: T) => CursorQueryBuilder<T>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  let last: T | undefined;
  for (;;) {
    const query = ordered(last === undefined ? build() : after(build(), last));
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const { data, error } = await query.limit(PAGE_SIZE);
    if (error) return { data: all, error };
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return { data: all, error: null };
    last = batch[batch.length - 1];
  }
}

export function fetchAllAfterId<T extends { id: string }>(
  build: () => CursorQueryBuilder<T>,
) {
  return fetchAllByCursor(build, (query) => query.order("id"), (query, last) => query.gt("id", last.id));
}

export function fetchAllAfterDocumentField<T extends { document_id: string; field_name: string }>(
  build: () => CursorQueryBuilder<T>,
) {
  return fetchAllByCursor(
    build,
    (query) => query.order("document_id").order("field_name"),
    (query, last) => query.or(
      `document_id.gt.${JSON.stringify(last.document_id)},and(document_id.eq.${JSON.stringify(last.document_id)},field_name.gt.${JSON.stringify(last.field_name)})`,
    ),
  );
}

// Leitura que falha em vez de devolver meia tabela: metade das linhas vira
// número errado com cara de completo.
export function rowsOrThrow<T>(
  label: string,
  { data, error }: { data: T[] | null; error: { message: string } | null },
): T[] {
  if (error) throw new Error(`${label}: ${error.message}`, { cause: error });
  return data ?? [];
}

// Lote do `.in("document_id", ...)`: uma lista longa de UUIDs vai na URL do
// PostgREST, e cem ficam bem abaixo do limite.
const DOCUMENT_CHUNK = 100;
// Lotes em voo ao mesmo tempo. Uma lista de milhares de documentos não pode
// virar dezenas de requisições simultâneas contra o PostgREST.
const CHUNK_CONCURRENCY = 4;

export type PagedRead<T> = Promise<{ data: T[]; error: { message: string } | null }>;

// Leitura restrita a `documentIds`, um `.in` por lote, até `concurrency` lotes
// em paralelo. A primeira falha vence e para de abrir lotes: um lote faltando
// daria número errado, não erro.
export async function fetchByDocumentChunks<T>(
  documentIds: readonly string[],
  fetchChunk: (ids: string[]) => PagedRead<T>,
  concurrency = CHUNK_CONCURRENCY,
): PagedRead<T> {
  const chunks: string[][] = [];
  for (let i = 0; i < documentIds.length; i += DOCUMENT_CHUNK) {
    chunks.push(documentIds.slice(i, i + DOCUMENT_CHUNK));
  }
  let failed: { message: string } | null = null;
  const results = await mapWithConcurrency(chunks, concurrency, async (ids) => {
    if (failed) return null;
    const result = await fetchChunk(ids);
    failed ??= result.error;
    return result;
  });
  if (failed) return { data: [], error: failed };
  return { data: results.flatMap((result) => result?.data ?? []), error: null };
}
