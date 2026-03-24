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
      .select("*", { count: "exact", head: true })
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

export interface LlmRunHistoryItem {
  respondent_name: string;
  docCount: number;
  latestAt: string;
}

export async function getLlmRunHistory(
  projectId: string
): Promise<LlmRunHistoryItem[]> {
  const supabase = await createSupabaseServer();

  const { data: responses } = await supabase
    .from("responses")
    .select("respondent_name, document_id, created_at")
    .eq("project_id", projectId)
    .eq("respondent_type", "llm")
    .eq("is_current", true);

  if (!responses || responses.length === 0) return [];

  const groups = new Map<
    string,
    { docs: Set<string>; latestAt: string }
  >();
  for (const r of responses) {
    const name = r.respondent_name ?? "unknown";
    if (!groups.has(name)) {
      groups.set(name, { docs: new Set(), latestAt: r.created_at });
    }
    const g = groups.get(name)!;
    g.docs.add(r.document_id);
    if (r.created_at > g.latestAt) g.latestAt = r.created_at;
  }

  return [...groups.entries()]
    .map(([name, g]) => ({
      respondent_name: name,
      docCount: g.docs.size,
      latestAt: g.latestAt,
    }))
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
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
