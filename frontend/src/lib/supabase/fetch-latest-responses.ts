import { latestResponseIndexKey, type LatestResponseRow } from "@/lib/latest-response-uniqueness";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import { fetchAllAfterId, PAGE_SIZE, type CursorQueryBuilder, type PagedRead } from "@/lib/supabase/fetch-all-paged";

// Folga para o relógio do servidor do app estar adiantado em relação ao do
// banco: o que a releitura trouxer a mais sai na deduplicação.
const CLOCK_SKEW_MARGIN_MS = 5 * 60_000;

// As colunas das chaves dos índices únicos de `is_latest`: a leitura as pede
// sempre, porque é por elas que deduplica.
const KEY_COLUMNS = "id, round_id, document_id, respondent_type, respondent_id";
type LatestResponseKey = Omit<LatestResponseRow, "project_id">;

// Respostas vigentes (`is_latest`) de um projeto, lidas inteiras, com os filtros de
// projeto e de `is_latest` aplicados aqui. `extraColumns` são as colunas de `T`
// além das da chave.
//
// Cada página do cursor é um statement, e publicar uma resposta LLM troca a
// vigente do documento por uma linha nova (id novo) entre dois deles. Se a
// antiga já foi lida e a nova cai depois do cursor, o respondente sai duas
// vezes; se a antiga ainda não foi lida e a nova cai antes do cursor, ele some.
// Por isso a leitura de mais de um statement relê o que foi criado desde o
// começo e, em cada chave dos índices únicos de `is_latest`, fica com a linha
// lida por último: uma linha só é lida como vigente depois da que ela
// substituiu.
//
// O que isto não cobre: rebaixamento sem linha nova (o início de rodada rebaixa
// a rodada inteira de uma vez) ainda pode sair metade antes e metade depois, e
// a releitura depende de o relógio do app não estar mais de 5 minutos à frente
// do banco. Leitura de fato atômica pede função no banco.
export async function fetchLatestResponses<T>(
  client: Pick<SupabaseServerClient, "from">,
  projectId: string,
  extraColumns: string,
): PagedRead<T & LatestResponseKey> {
  type Row = T & LatestResponseKey;
  // `as never`: o parser de select do supabase-js não infere colunas de string
  // montada; o tipo das linhas vem de `T`.
  const build = (): CursorQueryBuilder<Row> =>
    client.from("responses").select(`${KEY_COLUMNS}, ${extraColumns}`).eq("project_id", projectId).eq("is_latest", true) as never;
  const readStart = new Date(Date.now() - CLOCK_SKEW_MARGIN_MS).toISOString();
  const paged = await fetchAllAfterId<Row>(build);
  // Menos de uma página é um statement só, coerente por si.
  if (paged.error || paged.data.length < PAGE_SIZE) return paged;
  const created = await fetchAllAfterId<Row>(() => build().gt("created_at", readStart));
  if (created.error) return { data: paged.data, error: created.error };
  const latest = new Map<string, Row>();
  for (const row of [...paged.data, ...created.data]) {
    // Linha sem chave de índice não colide com nenhuma outra.
    latest.set(latestResponseIndexKey({ ...row, project_id: projectId }) ?? row.id, row);
  }
  return { data: [...latest.values()], error: null };
}
