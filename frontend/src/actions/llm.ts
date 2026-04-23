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
