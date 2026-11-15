import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";
import type { SupabaseServerClient } from "@/lib/supabase/server";

type DataClient = Pick<SupabaseServerClient, "from">;

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
export function docsWithoutLlm(
  humanDocIds: Iterable<string>,
  llmDocIds: Iterable<string>,
): Set<string> {
  const llm = new Set(llmDocIds);
  return new Set([...humanDocIds].filter((id) => !llm.has(id)));
}

// `reviewedDocIds` só é lido fora do modo de auto-revisão.
export function countEligibleWithoutLlm(
  automationMode: string | null,
  withoutLlm: ReadonlySet<string>,
  reviewedDocIds: Iterable<string>,
): number {
  if (automationMode === "auto_review_llm") return withoutLlm.size;
  const reviewed = new Set(reviewedDocIds);
  return [...withoutLlm].filter((id) => reviewed.has(id)).length;
}

interface DocRow {
  document_id: string;
}

function fetchCurrentResponseDocs(
  client: DataClient,
  projectId: string,
  respondentType: "humano" | "llm",
) {
  return fetchAllPaged<DocRow>(
    () =>
      client
        .from("responses")
        .select("id, document_id")
        .eq("project_id", projectId)
        .eq("respondent_type", respondentType)
        .eq("is_latest", true)
        .eq("is_partial", false) as never,
    ["id"],
  );
}

function fetchReviewDocs(
  client: DataClient,
  projectId: string,
  table: "field_reviews" | "field_review_cycle_history_entries",
) {
  return fetchAllPaged<DocRow>(
    () =>
      client.from(table).select("id, document_id").eq("project_id", projectId) as never,
    ["id"],
  );
}

const docIds = (rows: DocRow[]) => rows.map((row) => row.document_id);

// Leitura separada da RPC, sem a trava por documento que ela toma: é uma
// ressalva informativa, não parte do reparo. Paginada porque o teto de 1000
// linhas do PostgREST truncaria a contagem em silêncio.
export async function fetchDocsWithoutLlmCount(
  client: DataClient,
  projectId: string,
): Promise<{ count: number; error: null } | { count: null; error: { message: string } }> {
  const [projectResult, humanResult, llmResult] = await Promise.all([
    client.from("projects").select("automation_mode").eq("id", projectId).single(),
    fetchCurrentResponseDocs(client, projectId, "humano"),
    fetchCurrentResponseDocs(client, projectId, "llm"),
  ]);
  const firstError = projectResult.error ?? humanResult.error ?? llmResult.error;
  if (firstError) return { count: null, error: firstError };

  const automationMode =
    (projectResult.data as { automation_mode: string | null } | null)?.automation_mode ?? null;
  const withoutLlm = docsWithoutLlm(docIds(humanResult.data), docIds(llmResult.data));
  // A segunda fase só é necessária fora do modo de auto-revisão e quando há
  // candidato: no caso comum ela não custa nada.
  if (automationMode === "auto_review_llm" || withoutLlm.size === 0) {
    return { count: withoutLlm.size, error: null };
  }

  const [reviewsResult, historyResult] = await Promise.all([
    fetchReviewDocs(client, projectId, "field_reviews"),
    fetchReviewDocs(client, projectId, "field_review_cycle_history_entries"),
  ]);
  const reviewError = reviewsResult.error ?? historyResult.error;
  if (reviewError) return { count: null, error: reviewError };
  return {
    count: countEligibleWithoutLlm(automationMode, withoutLlm, [
      ...docIds(reviewsResult.data),
      ...docIds(historyResult.data),
    ]),
    error: null,
  };
}
