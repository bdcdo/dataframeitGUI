import { mapWithConcurrency } from "@/lib/upload-chunking";
import { latestResponseIndexKey, type LatestResponseRow } from "@/lib/latest-response-uniqueness";

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
const PAGE_SIZE = 1000;

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
// respostas vigentes, ver `fetchLatestResponses`).
interface CursorQueryBuilder<T> extends PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
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

// Folga para o relógio do servidor do app estar adiantado em relação ao do
// banco: o que a releitura trouxer a mais sai na deduplicação.
const CLOCK_SKEW_MARGIN_MS = 5 * 60_000;

// As colunas que `fetchLatestResponses` exige no select.
export type LatestResponseCursorRow = Omit<LatestResponseRow, "project_id"> & { created_at: string };

function isNewerResponse(a: LatestResponseCursorRow, b: LatestResponseCursorRow): boolean {
  const diff = Date.parse(a.created_at) - Date.parse(b.created_at);
  return diff > 0 || (diff === 0 && a.id > b.id);
}

// Respostas vigentes (`is_latest`) de UM projeto, coerentes entre as páginas.
// `build` já traz os filtros de projeto e de `is_latest`.
//
// Cada página do cursor é um statement, e publicar uma resposta LLM troca a
// vigente do documento por uma linha nova (id novo) entre dois deles. Se a
// antiga já foi lida e a nova cai depois do cursor, o respondente sai duas
// vezes; se a antiga ainda não foi lida e a nova cai antes do cursor, ele some.
// Por isso a leitura de mais de um statement relê o que foi criado desde o
// começo e fica com a linha mais nova de cada chave dos índices únicos de
// `is_latest`. Só linha nova vira vigente (a resposta humana é atualizada no
// lugar, sem trocar de id), então a releitura alcança toda troca.
export async function fetchLatestResponses<T extends LatestResponseCursorRow>(
  projectId: string,
  build: () => CursorQueryBuilder<T>,
): PagedRead<T> {
  const readStart = new Date(Date.now() - CLOCK_SKEW_MARGIN_MS).toISOString();
  const paged = await fetchAllAfterId<T>(build);
  // Menos de uma página é um statement só, coerente por si.
  if (paged.error || paged.data.length < PAGE_SIZE) return paged;
  const created = await fetchAllAfterId<T>(() => build().gt("created_at", readStart));
  if (created.error) return { data: paged.data, error: created.error };
  const newest = new Map<string, T>();
  for (const row of [...paged.data, ...created.data]) {
    // Linha sem chave de índice não colide com nenhuma outra.
    const key = latestResponseIndexKey({ ...row, project_id: projectId }) ?? row.id;
    const kept = newest.get(key);
    if (!kept || isNewerResponse(row, kept)) newest.set(key, row);
  }
  return { data: [...newest.values()], error: null };
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
