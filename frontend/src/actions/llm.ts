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
