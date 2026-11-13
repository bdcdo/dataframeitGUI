import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import { VALUE_EQUIVALENCE_SELECT, type ValueEquivalence } from "@/lib/equivalence";
import { PYTHON_IDENTIFIER } from "@/lib/pydantic-field";

type DataClient = Pick<SupabaseServerClient, "from">;

// Todas as equivalências de valor vivas do projeto. O escopo é o projeto, não
// o documento: a mesma lista vale para todo documento, por isso nenhum leitor
// filtra por documento. Paginado porque um projeto pode passar das 1000
// linhas do teto do PostgREST, e truncar aqui fundiria menos do que devia sem
// erro nenhum. Serve ao cliente do usuário (RLS de leitura por membro) e ao
// admin, que têm a mesma interface. `extraColumns` para quem precisa de mais
// que o necessário à fusão (a aba Equivalências: origem e data).
export function fetchProjectValueEquivalences<T extends ValueEquivalence = ValueEquivalence>(
  client: DataClient,
  projectId: string,
  extraColumns = "",
): Promise<{ data: T[]; error: { message: string } | null }> {
  // `as typeof VALUE_EQUIVALENCE_SELECT`: o parser de select do supabase-js
  // não infere colunas de string montada; o tipo das linhas vem de `T`.
  const columns = (extraColumns
    ? `${VALUE_EQUIVALENCE_SELECT}, ${extraColumns}`
    : VALUE_EQUIVALENCE_SELECT) as typeof VALUE_EQUIVALENCE_SELECT;
  return fetchAllPaged<T>(
    () => client.from("value_equivalences").select(columns).eq("project_id", projectId) as never,
    ["id"],
  );
}

export interface FieldAnswerQueryRow {
  id: string;
  document_id: string;
  answer_field_hashes: Record<string, string | null> | null;
  /** O valor do campo (a resposta sem a chave não vem). */
  value: unknown;
  documents: { title: string | null; external_id: string | null } | null;
}

// As respostas vigentes ao campo nos documentos ativos do projeto, só com o
// valor do campo (caminho JSON), não o `answers` inteiro. Fonte única da
// leitura por valor: os documentos afetados por uma equivalência e o "onde se
// aplica" da aba usam a mesma régua de quais respostas contam.
export function fetchFieldAnswers(
  client: DataClient,
  projectId: string,
  fieldName: string,
): Promise<{ data: FieldAnswerQueryRow[]; error: { message: string } | null }> {
  // O nome entra no select como caminho JSON do PostgREST: só identificador
  // de campo do schema passa.
  if (!PYTHON_IDENTIFIER.test(fieldName)) {
    return Promise.resolve({ data: [], error: { message: `nome de campo inválido: ${fieldName}` } });
  }
  // Tipado como `string` para o parser de select do supabase-js não tentar
  // inferir o caminho dinâmico.
  const columns: string = `id, document_id, answer_field_hashes, value:answers->${fieldName}, documents!inner(title, external_id)`;
  return fetchAllPaged<FieldAnswerQueryRow>(
    () =>
      client
        .from("responses")
        .select(columns)
        .eq("project_id", projectId)
        .eq("is_latest", true)
        // `answers->campo` é SQL NULL só sem a chave (o JSON null é `'null'`):
        // a resposta que não respondeu o campo fica de fora, como na
        // Comparação, e não se confunde com quem respondeu null.
        .not(`answers->${fieldName}`, "is", null)
        .is("documents.excluded_at", null)
        .returns<FieldAnswerQueryRow[]>(),
    ["id"],
  );
}
