"use server";

import { createSupabaseServer } from "@/lib/supabase/server";

export async function getEligibleDocCount(
  projectId: string,
  filterMode: "all" | "pending" | "max_responses" | "random_sample",
  maxResponseCount?: number
): Promise<{ total: number; eligible: number }> {
  const supabase = await createSupabaseServer();

  const [{ count: total }, { data: llmResponses }] = await Promise.all([
    supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId),
    supabase
      .from("responses")
      .select("document_id")
      .eq("project_id", projectId)
      .eq("respondent_type", "llm")
      .eq("is_current", true),
  ]);

  const totalDocs = total ?? 0;

  if (filterMode === "all" || filterMode === "random_sample") {
    return { total: totalDocs, eligible: totalDocs };
  }

  // Count LLM responses per document
  const counts = new Map<string, number>();
  for (const r of llmResponses ?? []) {
    counts.set(r.document_id, (counts.get(r.document_id) ?? 0) + 1);
  }

  if (filterMode === "pending") {
    const docsWithLlm = counts.size;
    return { total: totalDocs, eligible: totalDocs - docsWithLlm };
  }

  if (filterMode === "max_responses" && maxResponseCount != null) {
    // Docs with <= maxResponseCount LLM responses (including 0)
    const docsExceeding = [...counts.values()].filter(
      (c) => c > maxResponseCount
    ).length;
    return { total: totalDocs, eligible: totalDocs - docsExceeding };
  }

  return { total: totalDocs, eligible: totalDocs };
}

export interface DocSelectionItem {
  id: string;
  title: string | null;
  external_id: string | null;
  hasHumanResponse: boolean;
  llmResponseCount: number;
}

export interface LlmRunRecord {
  id: string;
  job_id: string;
  status: "running" | "completed" | "error";
  phase: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  filter_mode: string | null;
  document_count: number | null;
  progress: number;
  total: number;
  pydantic_code: string | null;
  error_message: string | null;
  error_type: string | null;
  error_traceback: string | null;
  error_line: number | null;
  error_column: number | null;
  started_at: string;
  completed_at: string | null;
}

export async function getLlmRuns(
  projectId: string,
  limit = 20
): Promise<LlmRunRecord[]> {
  const supabase = await createSupabaseServer();

  const { data } = await supabase
    .from("llm_runs")
    .select(
      "id, job_id, status, phase, llm_provider, llm_model, filter_mode, " +
        "document_count, progress, total, pydantic_code, error_message, " +
        "error_type, error_traceback, error_line, error_column, started_at, completed_at"
    )
    .eq("project_id", projectId)
    .order("started_at", { ascending: false })
    .limit(limit);

  return (data ?? []) as unknown as LlmRunRecord[];
}

export async function getRunningLlmCount(projectId: string): Promise<number> {
  const supabase = await createSupabaseServer();
  const { count } = await supabase
    .from("llm_runs")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("status", "running");
  return count ?? 0;
}

export async function getLlmRunStats(
  jobId: string
): Promise<{ current: number; partial: number }> {
  const supabase = await createSupabaseServer();
  // Usa is_partial (imutável) em vez de is_current para distinguir complete vs
  // partial. is_current muda quando uma run posterior roda nos mesmos docs, o
  // que inflaria artificialmente a contagem de parciais de runs antigas.
  const [{ count: complete }, { count: partial }] = await Promise.all([
    supabase
      .from("responses")
      .select("id", { count: "exact", head: true })
      .eq("llm_job_id", jobId)
      .eq("is_partial", false),
    supabase
      .from("responses")
      .select("id", { count: "exact", head: true })
      .eq("llm_job_id", jobId)
      .eq("is_partial", true),
  ]);
  return { current: complete ?? 0, partial: partial ?? 0 };
}

export interface LlmResponseRecord {
  id: string;
  document_id: string;
  llm_job_id: string | null;
  is_current: boolean;
  is_partial: boolean;
  answers: Record<string, unknown>;
  justifications: Record<string, string> | null;
  respondent_name: string | null;
  created_at: string;
  // Diagnostico por documento gravado pelo backend quando a resposta saiu
  // vazia, parcial ou com erro do dataframeit. Null quando a resposta foi
  // integra. Ver migration 20260504000002_responses_llm_error.sql.
  llm_error: string | null;
  document: {
    id: string;
    title: string | null;
    external_id: string | null;
  } | null;
}

export async function getLlmResponsesForProject(
  projectId: string,
  options: { jobId?: string; limit?: number; offset?: number } = {}
): Promise<LlmResponseRecord[]> {
  const supabase = await createSupabaseServer();
  const limit = options.limit ?? 200;
  const offset = options.offset ?? 0;

  let query = supabase
    .from("responses")
    .select(
      "id, document_id, llm_job_id, is_current, is_partial, answers, " +
        "justifications, respondent_name, created_at, llm_error, " +
        "documents(id, title, external_id)"
    )
    .eq("project_id", projectId)
    .eq("respondent_type", "llm")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (options.jobId) query = query.eq("llm_job_id", options.jobId);

  const { data } = await query;

  return ((data ?? []) as unknown as Array<{
    id: string;
    document_id: string;
    llm_job_id: string | null;
    is_current: boolean;
    is_partial: boolean;
    answers: Record<string, unknown> | null;
    justifications: Record<string, string> | null;
    respondent_name: string | null;
    created_at: string;
    llm_error: string | null;
    documents:
      | { id: string; title: string | null; external_id: string | null }
      | null;
  }>).map((r) => ({
    id: r.id,
    document_id: r.document_id,
    llm_job_id: r.llm_job_id,
    is_current: r.is_current,
    is_partial: r.is_partial,
    answers: r.answers ?? {},
    justifications: r.justifications,
    respondent_name: r.respondent_name,
    created_at: r.created_at,
    llm_error: r.llm_error,
    document: r.documents,
  }));
}

export interface RunningLlmJob {
  job_id: string;
  started_at: string;
}

/**
 * Retorna a run LLM com status='running' mais recente do projeto, ou null.
 * Usado pelo LlmConfigurePane para retomar o card de execução em andamento
 * quando o usuário recarrega a página ou volta para a aba.
 */
export async function getRunningLlmJob(
  projectId: string
): Promise<RunningLlmJob | null> {
  const supabase = await createSupabaseServer();
  const { data } = await supabase
    .from("llm_runs")
    .select("job_id, started_at")
    .eq("project_id", projectId)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { job_id: data.job_id, started_at: data.started_at };
}

export async function getDocumentsForSelection(
  projectId: string
): Promise<DocSelectionItem[]> {
  const supabase = await createSupabaseServer();

  const [{ data: docs }, { data: responses }] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title, external_id")
      .eq("project_id", projectId)
      .order("external_id"),
    supabase
      .from("responses")
      .select("document_id, respondent_type")
      .eq("project_id", projectId)
      .eq("is_current", true),
  ]);

  const humanDocs = new Set<string>();
  const llmCounts = new Map<string, number>();
  for (const r of responses ?? []) {
    if (r.respondent_type === "humano") humanDocs.add(r.document_id);
    if (r.respondent_type === "llm") {
      llmCounts.set(r.document_id, (llmCounts.get(r.document_id) ?? 0) + 1);
    }
  }

  return (docs ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    external_id: d.external_id,
    hasHumanResponse: humanDocs.has(d.id),
    llmResponseCount: llmCounts.get(d.id) ?? 0,
  }));
}
