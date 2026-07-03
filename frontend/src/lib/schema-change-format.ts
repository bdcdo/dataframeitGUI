import type { FieldCondition } from "./types";
import { TYPE_LABELS } from "./field-labels";
import type { FieldPropertyDiff } from "./schema-change-diff";

export function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  if (diffMs < 60_000) return "agora";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `há ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} ${hours === 1 ? "hora" : "horas"}`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ontem";
  if (days < 7) return `há ${days} dias`;
  return new Date(iso).toLocaleDateString("pt-BR");
}

export function formatVersion(
  v: { major: number; minor: number; patch: number } | null,
): string {
  if (!v) return "—";
  return `v${v.major}.${v.minor}.${v.patch}`;
}

export function formatCondition(c: FieldCondition | null | undefined): string {
  if (!c) return "sem condição";
  if ("equals" in c) return `${c.field} = ${formatScalar(c.equals)}`;
  if ("not_equals" in c) return `${c.field} ≠ ${formatScalar(c.not_equals)}`;
  if ("in" in c) return `${c.field} ∈ [${c.in.map(formatScalar).join(", ")}]`;
  if ("not_in" in c) return `${c.field} ∉ [${c.not_in.map(formatScalar).join(", ")}]`;
  if ("exists" in c) return c.exists ? `${c.field} existe` : `${c.field} ausente`;
  return "sem condição";
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

const TARGET_LABELS: Record<string, string> = {
  all: "Todos",
  llm_only: "Só LLM",
  human_only: "Só humano",
  none: "Nenhum",
};

export function formatTarget(t: unknown): string {
  if (typeof t !== "string") return "—";
  return TARGET_LABELS[t] ?? t;
}

export function formatType(t: unknown): string {
  if (typeof t !== "string") return "—";
  return TYPE_LABELS[t] ?? t;
}

const PROPERTY_LABELS: Record<FieldPropertyDiff["property"], string> = {
  name: "nome",
  description: "descrição",
  help_text: "instruções",
  options: "opções",
  type: "tipo",
  target: "alvo",
  required: "obrigatoriedade",
  allow_other: "permite outro",
  subfield_rule: "regra de subcampos",
  subfields: "subcampos",
  condition: "condição",
  justification_prompt: "prompt de justificativa",
};

export function propertyLabel(p: FieldPropertyDiff["property"]): string {
  return PROPERTY_LABELS[p];
}
