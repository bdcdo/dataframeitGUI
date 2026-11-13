import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import { VALUE_EQUIVALENCE_SELECT, type ValueEquivalence } from "@/lib/equivalence";

// Todas as equivalências de valor vivas do projeto. O escopo é o projeto, não
// o documento: a mesma lista vale para todo documento, por isso nenhum leitor
// filtra por documento. Paginado porque um projeto pode passar das 1000
// linhas do teto do PostgREST, e truncar aqui fundiria menos do que devia sem
// erro nenhum. Serve ao cliente do usuário (RLS de leitura por membro) e ao
// admin, que têm a mesma interface.
export function fetchProjectValueEquivalences(
  client: Pick<SupabaseServerClient, "from">,
  projectId: string,
): Promise<{ data: ValueEquivalence[]; error: { message: string } | null }> {
  return fetchAllPaged<ValueEquivalence>(
    () =>
      client
        .from("value_equivalences")
        .select(VALUE_EQUIVALENCE_SELECT)
        .eq("project_id", projectId),
    ["id"],
  );
}

// Pydantic exige identificador Python, e o nome entra no `select` como
// caminho JSON do PostgREST: qualquer outra coisa é recusada antes da query.
export const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface FieldAnswerQueryRow {
  id: string;
  document_id: string;
  answer_field_hashes: Record<string, string | null> | null;
  /** O valor do campo (a resposta sem a chave não vem). */
  value: unknown;
  documents: { title: string | null; external_id: string | null } | null;
}

// As respostas vigentes ao campo nos documentos ativos do projeto, só com o
// valor do campo (caminho JSON), não o `answers` inteiro.
export function fetchFieldAnswers(
  client: Pick<SupabaseServerClient, "from">,
  projectId: string,
  fieldName: string,
): Promise<{ data: FieldAnswerQueryRow[]; error: { message: string } | null }> {
  if (!FIELD_NAME_PATTERN.test(fieldName)) {
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
        // SQL NULL só sem a chave: quem não respondeu o campo fica de fora.
        .not(`answers->${fieldName}`, "is", null)
        .is("documents.excluded_at", null)
        .returns<FieldAnswerQueryRow[]>(),
    ["id"],
  );
}
