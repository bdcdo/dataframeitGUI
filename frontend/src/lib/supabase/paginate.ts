// O PostgREST limita cada resposta a `max_rows` (1000 por padrão, hospedado e
// local). Uma query sem paginação não falha ao ultrapassar o teto: ela devolve
// as primeiras 1000 linhas como se fossem o conjunto inteiro. Quem usa o
// resultado como universo — "estes são os membros do projeto" — passa a tratar
// o que ficou de fora como inexistente, sem nenhum sinal de erro.
export const SUPABASE_PAGE_SIZE = 1000;

// Teto de páginas. Um cliente que ignore o `.range()` devolveria a mesma página
// para sempre e o laço abaixo nunca terminaria — travando o request em vez de
// falhar. Em 10 milhões de linhas nenhuma leitura legítima deste app chega
// perto, então estourar o teto é sempre defeito de quem responde, e o erro diz
// isso em voz alta em vez de girar em silêncio.
const MAX_PAGES = 10_000;

// `build()` recria a query a cada página porque um builder do PostgREST é de
// uso único: o await o executa e ele não pode ser reaproveitado.
// O avanço usa o tamanho REALMENTE recebido, e o fim é a página vazia — não
// `batch.length < SUPABASE_PAGE_SIZE`. Comparar com o tamanho pedido presume que
// o `max_rows` do servidor é igual ao nosso: onde ele for menor, a primeira
// página já vem "incompleta", o laço encerra e a leitura volta a truncar
// silenciosamente — exatamente o defeito que esta função existe para impedir.
// O custo é uma requisição a mais no fim, que também seria necessária quando o
// total é múltiplo exato da página.
export async function fetchAllPaged<T>(
  build: () => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  let from = 0;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      throw new Error(
        `fetchAllPaged: ${MAX_PAGES} páginas sem fim à vista (${all.length} linhas). ` +
          "O cliente provavelmente está ignorando .range().",
      );
    }
    // await sequencial é da natureza da paginação: só dá para pedir a próxima
    // página sabendo o que a anterior devolveu.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const { data, error } = await build().range(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) return { data: all, error };
    const batch = data ?? [];
    if (batch.length === 0) break;
    all.push(...batch);
    from += batch.length;
  }
  return { data: all, error: null };
}
