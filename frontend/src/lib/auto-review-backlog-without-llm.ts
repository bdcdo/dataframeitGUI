import { fetchAllPaged, fetchByDocumentChunks } from "@/lib/supabase/fetch-all-paged";
import type { SupabaseServerClient } from "@/lib/supabase/server";

type DataClient = Pick<SupabaseServerClient, "from">;

interface DocRow {
  document_id: string;
}

const docIds = (rows: DocRow[]) => new Set(rows.map((row) => row.document_id));

// Quantos documentos a regeneração do backlog de auto-revisão deixa de fora
// por não terem geração LLM corrente (#690). Desde a #670,
// `enqueue_auto_review_reconciliation_for_project` só enfileira documento com
// resposta LLM `is_latest` completa (JOIN LATERAL); o resto some em silêncio, e
// num projeto com round reiniciado (que arquiva toda geração LLM) o toast dizia
// "0 documento(s) reenfileirado(s)" como se não houvesse nada a fazer.
//
// O critério espelha o WHERE da RPC (migration
// 20260811130000_auto_review_reconciliation_requires_llm.sql), trocando só a
// exigência da geração LLM pela sua ausência: codificação humana corrente e
// completa, e o projeto em `auto_review_llm` ou o documento já com auto-revisão
// (vigente ou em histórico). Fora do modo de auto-revisão, documento sem
// histórico de auto-revisão não entraria nem com LLM, então não conta.
//
// Um desvio deliberado da RPC: documento excluído (ou com exclusão pendente)
// não conta. A RPC não os filtra, mas o runner LLM os pula, e a ressalva manda
// rodar o LLM — contá-los deixaria um aviso que nenhuma ação apaga.
//
// Mudou o WHERE da RPC? Mude este critério junto: nada amarra os dois.
//
// Leitura separada da RPC, sem a trava por documento que ela toma: é uma
// ressalva informativa, não parte do reparo. Paginada porque o teto de 1000
// linhas do PostgREST truncaria a contagem em silêncio.
//
// Nunca rejeita: uma exceção também vira `error`, para que nenhum chamador
// troque o reparo ou a tela por uma falha por causa da ressalva.
export async function fetchDocsWithoutLlmCount(
  client: DataClient,
  projectId: string,
): Promise<CountResult> {
  try {
    return await countDocsWithoutLlm(client, projectId);
  } catch (error) {
    return {
      count: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

type CountResult =
  | { count: number; error: null }
  | { count: null; error: { message: string } };

async function countDocsWithoutLlm(
  client: DataClient,
  projectId: string,
): Promise<CountResult> {
  const [projectResult, humanResult, llmResult] = await Promise.all([
    client.from("projects").select("automation_mode").eq("id", projectId).single(),
    // O filtro de exclusão só vai no lado humano: é ele que define os candidatos.
    fetchAllPaged<DocRow>(
      () =>
        client
          .from("responses")
          .select("id, document_id, documents!inner(excluded_at, exclusion_pending_at)")
          .eq("project_id", projectId)
          .eq("respondent_type", "humano")
          .eq("is_latest", true)
          .eq("is_partial", false)
          .is("documents.excluded_at", null)
          .is("documents.exclusion_pending_at", null),
      ["id"],
    ),
    fetchAllPaged<DocRow>(
      () =>
        client
          .from("responses")
          .select("id, document_id")
          .eq("project_id", projectId)
          .eq("respondent_type", "llm")
          .eq("is_latest", true)
          .eq("is_partial", false),
      ["id"],
    ),
  ]);
  const firstError = projectResult.error ?? humanResult.error ?? llmResult.error;
  if (firstError) return { count: null, error: firstError };

  const withoutLlm = docIds(humanResult.data).difference(docIds(llmResult.data));
  // A segunda fase só é necessária fora do modo de auto-revisão e quando há
  // candidato: no caso comum ela não custa nada.
  if (projectResult.data?.automation_mode === "auto_review_llm" || withoutLlm.size === 0) {
    return { count: withoutLlm.size, error: null };
  }

  // Só as auto-revisões dos candidatos, não as do projeto inteiro.
  const candidates = [...withoutLlm];
  const reviewedCandidates = (
    table: "field_reviews" | "field_review_cycle_history_entries",
  ) =>
    fetchByDocumentChunks(candidates, (ids) =>
      fetchAllPaged<DocRow>(
        () =>
          client
            .from(table)
            .select("id, document_id")
            .eq("project_id", projectId)
            .in("document_id", ids),
        ["id"],
      ),
    );
  const [reviewsResult, historyResult] = await Promise.all([
    reviewedCandidates("field_reviews"),
    reviewedCandidates("field_review_cycle_history_entries"),
  ]);
  const reviewError = reviewsResult.error ?? historyResult.error;
  if (reviewError) return { count: null, error: reviewError };
  return { count: docIds([...reviewsResult.data, ...historyResult.data]).size, error: null };
}
