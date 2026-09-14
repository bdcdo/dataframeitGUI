import type { ErrorDecision, ErrorResolutionContext, ErrorResolutionRow } from "@/lib/error-resolution";

export function resolutionFixture(decision: ErrorDecision = "llm_correct"): ErrorResolutionRow {
  const context: ErrorResolutionContext = {
    project_id: "p1", document_id: "doc1", field_name: "x", round_id: "round1",
    automation_mode: "compare_llm", field_definition: { name: "x", type: "text", description: "Pergunta" },
    llm_response_id: "rllm", human_response_id: "rh",
    llm_value: { present: true, value: "LLM" }, human_value: { present: true, value: "Humano" },
    source: { kind: "comparacao", id: "review1", verdict: "Humano" },
  };
  return { id: "resolution1", project_id: "p1", document_id: "doc1", field_name: "x",
    decision, context, current_context: structuredClone(context),
    resolved_at: "2026-09-14T12:00:00Z", resolved_by: "user1", note: "Conferido" };
}
