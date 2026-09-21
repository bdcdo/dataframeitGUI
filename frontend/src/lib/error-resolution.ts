import { z } from "zod";
import { stableStringify } from "@/lib/schema-utils";
import { OTHER_PREFIX, isOtherValue } from "@/lib/other-option";
import { resolveAllowOther } from "@/lib/pydantic-field";
import { NOT_INFORMED } from "@/lib/sentinels";
import { isSubfieldRecord } from "@/lib/subfield-value";
import { arePartsValid, parseDatePartsForUI } from "@/lib/date-parts";
import type { PydanticField } from "@/lib/types";

// A ordem é a dos botões no card: quem errou (um lado, nenhum, os dois) e,
// por último, o adiamento.
export const errorDecisionSchema = z.enum(["llm_correct", "researchers_correct", "both_correct", "all_wrong", "discussion"]);
export type ErrorDecision = z.infer<typeof errorDecisionSchema>;
export const ERROR_DECISION_LABELS: Record<ErrorDecision, string> = {
  llm_correct: "Erro humano",
  researchers_correct: "Erro do LLM",
  both_correct: "Ambos corretos",
  all_wrong: "Todos errados",
  discussion: "Em discussão",
};

/**
 * Decisões em que o revisor escolhe o valor que vai ao gabarito, gravado em
 * `approved_value`. Espelha o CHECK `error_resolution_value_iff_chosen`.
 */
export type ValueChoosingDecision = Extract<ErrorDecision, "researchers_correct" | "all_wrong">;
export function choosesValue(decision: ErrorDecision): decision is ValueChoosingDecision {
  return decision === "researchers_correct" || decision === "all_wrong";
}

const answerSchema = z.object({ present: z.boolean(), value: z.json() });
export const errorResolutionContextSchema = z.object({
  project_id: z.string(), document_id: z.string(), field_name: z.string(),
  round_id: z.string().nullable(), automation_mode: z.string().nullable(),
  field_definition: z.json(), llm_response_id: z.string(), human_response_id: z.string(),
  llm_value: answerSchema, human_value: answerSchema,
  source: z.record(z.string(), z.json()),
});
export type ErrorResolutionContext = z.infer<typeof errorResolutionContextSchema>;

export const errorResolutionInputSchema = z.object({
  decision: errorDecisionSchema,
  context: errorResolutionContextSchema,
  expected: z.object({ id: z.string(), resolved_at: z.string() }).nullable(),
  note: z.string().optional(),
  /**
   * O valor que vai ao gabarito nas decisões de `choosesValue`, escolhido
   * pelo revisor nas opções atuais do campo (#733). A RPC valida o domínio.
   */
  value: z.json().optional(),
});
export type ErrorResolutionInput = z.infer<typeof errorResolutionInputSchema>;

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
  /** Coluna `approved_value`: só nas decisões de `choosesValue` (CHECK no banco). */
  approved_value?: unknown;
}

export type EffectiveErrorResolution =
  | { status: "open" }
  | { status: "legacy" }
  | { status: "stale" }
  | { status: "discussion" }
  /**
   * "Ambos corretos": nenhum valor é aprovado, o gabarito continua sendo o
   * veredito da arbitragem. `llmValue` é a resposta do LLM, que passa a contar
   * como correta ao lado dele. `verdictValue` só existe na auto-revisão, cujo
   * veredito (a resposta humana do contexto) não chega ao export nem ao
   * Gabarito por outra via; na Comparação quem o traz é a própria review.
   */
  | { status: "upheld"; llmValue: unknown; verdictValue?: unknown }
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
  if (row.decision === "both_correct") {
    if (!context.llm_value.present) return { status: "stale" };
    const fromAutoReview = context.source.kind === "auto_revisao" && context.human_value.present;
    return { status: "upheld", llmValue: context.llm_value.value,
      ...(fromAutoReview ? { verdictValue: context.human_value.value } : {}) };
  }
  if (choosesValue(row.decision)) {
    // "Erro do LLM" e "Todos errados" aprovam o valor que o revisor escolheu, não a resposta de
    // um codificador: `human_value` fica no contexto só como âncora de
    // invalidação (#733). Linha sem coluna é anterior à migration e não é
    // aprovável até ser confirmada de novo.
    if (row.approved_value === undefined || row.approved_value === null) return { status: "stale" };
    return { status: "approved", value: row.approved_value, isLlmError: true };
  }
  if (!context.llm_value.present) return { status: "stale" };
  return { status: "approved", value: context.llm_value.value, isLlmError: false };
}

function hasSubfields(field: PydanticField): boolean {
  return field.type === "text" && (field.subfields?.length ?? 0) > 0;
}

/**
 * Valor inicial do seletor de "Erro do LLM" a partir de um valor já na forma
 * de `responses.answers` (snapshot humano da auto-revisão, valor aprovado de
 * uma decisão anterior): o que ainda cabe nas opções atuais da pergunta, ou
 * `undefined`.
 */
export function prefillFromValue(field: PydanticField, value: unknown): unknown {
  if (field.type === "single") return prefillSingle(field, value);
  if (field.type === "multi") return prefillMulti(field, value);
  if (hasSubfields(field)) return prefillGroup(value);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// Opção de formulário carrega espaço final; o valor gravado nem sempre.
function prefillSingle(field: PydanticField, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return field.options?.find((option) => option.trim() === value.trim());
}

function prefillMulti(field: PydanticField, value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const marked = new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim()));
  const chosen = (field.options ?? []).filter((option) => marked.has(option.trim()));
  return chosen.length > 0 ? chosen : undefined;
}

function prefillGroup(value: unknown): unknown {
  if (value === NOT_INFORMED) return NOT_INFORMED;
  return isSubfieldRecord(value) ? value : undefined;
}

/**
 * Valor inicial do seletor a partir do veredito da Comparação (`reviews.verdict`,
 * texto): traduzido para a forma da resposta quando ainda é opção atual da
 * pergunta; `undefined` quando não é (opção que saiu do formulário, JSON
 * ilegível, texto renderizado de subcampos) ou quando o veredito é um dos
 * marcadores da Comparação (`ambiguo`, `pular`, ver compare-types.ts), que
 * nunca são resposta.
 */
export function prefillFromVerdict(field: PydanticField, verdict: string): unknown {
  const text = verdict.trim();
  if (text === "ambiguo" || text === "pular") return undefined;
  if (field.type === "multi") {
    // O veredito de `multi` é o JSON `{opção: bool}` (ver `formatVerdict` e
    // `resolutionVerdict`); a resposta é o array das opções marcadas.
    let parsed: unknown;
    try { parsed = JSON.parse(verdict); } catch { return undefined; }
    if (!isSubfieldRecord(parsed)) return undefined;
    return prefillFromValue(field, Object.entries(parsed).filter(([, v]) => v === true).map(([k]) => k));
  }
  if (hasSubfields(field)) {
    // O veredito é o texto renderizado dos subcampos; reconstruir o objeto
    // seria inventar evidência. A sentinela é a única forma reconhecível.
    return text === NOT_INFORMED ? NOT_INFORMED : undefined;
  }
  return prefillFromValue(field, text === "" ? undefined : verdict);
}

// "Outro: " só com espaços é o prefixo sem complemento: o input de "Outro" do
// FieldRenderer grava `OTHER_PREFIX + texto`, e a RPC exige complemento.
function isFilledText(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  return !isOtherValue(value) || value.slice(OTHER_PREFIX.length).trim() !== "";
}

// Uma opção da pergunta, ou "Outro: <texto>" quando ela permite: o mesmo
// domínio que `set_error_resolution` aceita em `single` e em cada item de `multi`.
function isAllowedOption(field: PydanticField, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (field.options?.includes(value)) return true;
  return resolveAllowOther(field.allow_other) && isOtherValue(value) && isFilledText(value);
}

/**
 * Se o valor do seletor basta para ir ao gabarito. Espelha, na fronteira do
 * cliente, a validação de `set_error_resolution`, regra a regra: o botão só
 * habilita o que a RPC aceita.
 */
export function hasResolutionValue(field: PydanticField, value: unknown): boolean {
  if (field.type === "single") return isAllowedOption(field, value);
  if (field.type === "multi") {
    return Array.isArray(value) && value.length > 0 && value.every((v) => isAllowedOption(field, v));
  }
  if (hasSubfields(field)) return hasGroupValue(field, value);
  if (field.type === "date") return hasDateValue(field, value);
  return isFilledText(value);
}

function hasGroupValue(field: PydanticField, value: unknown): boolean {
  if (value === NOT_INFORMED) return true;
  if (!isSubfieldRecord(value)) return false;
  const known = new Set((field.subfields ?? []).map((sf) => sf.key));
  return Object.keys(value).every((k) => known.has(k))
    && Object.values(value).some((v) => typeof v === "string" && v.trim() !== "");
}

// O controle de data mostra vazio o que não parseia, então uma string solta
// ("ambiguo") passaria invisível ao banco. Só o formato parcial `DD/MM/AAAA`
// com alguma parte, ou uma sentinela do campo.
function hasDateValue(field: PydanticField, value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  if (value === NOT_INFORMED || (field.options ?? []).includes(value)) return true;
  const parts = parseDatePartsForUI(value);
  return value.split("/").length === 3 && parts.some((p) => p !== "") && arePartsValid(parts);
}

export function errorResolutionComment(row: ErrorResolutionRow): string {
  const result = effectiveErrorResolution(row);
  if (result.status !== "approved" && result.status !== "discussion" && result.status !== "upheld") return "";
  return `[${row.field_name}] ${ERROR_DECISION_LABELS[row.decision!]}${row.note ? `: ${row.note}` : ""}`;
}
