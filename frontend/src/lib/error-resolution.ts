import { z } from "zod";
import { stableStringify } from "@/lib/schema-utils";

export const errorDecisionSchema = z.enum(["llm_correct", "researchers_correct", "discussion"]);
export type ErrorDecision = z.infer<typeof errorDecisionSchema>;
export const ERROR_DECISION_LABELS: Record<ErrorDecision, string> = {
  llm_correct: "Erro humano",
  researchers_correct: "Erro do LLM",
  discussion: "Em discussão",
};

const answerSchema = z.object({ present: z.boolean(), value: z.json() });
export const errorResolutionContextSchema = z.object({
  project_id: z.string(), document_id: z.string(), field_name: z.string(),
  round_id: z.string().nullable(), automation_mode: z.string().nullable(),
  field_definition: z.json(), llm_response_id: z.string(), human_response_id: z.string(),
  llm_value: answerSchema, human_value: answerSchema,
  source: z.record(z.string(), z.json()),
});
export type ErrorResolutionContext = z.infer<typeof errorResolutionContextSchema>;

export interface ErrorResolutionRow {
  id: string;
  project_id: string;
  document_id: string;
  field_name: string;
  decision: ErrorDecision | null;
  context: ErrorResolutionContext | null;
  current_context: ErrorResolutionContext | null;
  resolved_at: string;
  resolved_by: string;
  note: string | null;
}

export type EffectiveErrorResolution =
  | { status: "open" }
  | { status: "legacy" }
  | { status: "stale" }
  | { status: "discussion" }
  | { status: "approved"; value: unknown; isLlmError: boolean };

export function effectiveErrorResolution(row: ErrorResolutionRow | undefined): EffectiveErrorResolution {
  if (!row) return { status: "open" };
  if (row.decision === null) return { status: "legacy" };
  const context = row.context;
  if (!context || !row.current_context ||
      context.project_id !== row.project_id || context.document_id !== row.document_id ||
      context.field_name !== row.field_name ||
      stableStringify(context) !== stableStringify(row.current_context)) {
    return { status: "stale" };
  }
  if (row.decision === "discussion") return { status: "discussion" };
  const answer = row.decision === "llm_correct" ? context.llm_value : context.human_value;
  if (!answer.present) return { status: "stale" };
  return { status: "approved", value: answer.value, isLlmError: row.decision === "researchers_correct" };
}

export function errorResolutionComment(row: ErrorResolutionRow): string {
  const result = effectiveErrorResolution(row);
  if (result.status !== "approved" && result.status !== "discussion") return "";
  return `[${row.field_name}] ${ERROR_DECISION_LABELS[row.decision!]}${row.note ? `: ${row.note}` : ""}`;
}
