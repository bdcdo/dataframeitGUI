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
 * `approved_value`. O CHECK `error_resolution_value_by_decision` exige o
 * valor nelas; "Ambos corretos" também pode ter valor, mas quem o calcula é o
 * servidor (`carriesValue`).
 */
export type ValueChoosingDecision = Extract<ErrorDecision, "researchers_correct" | "all_wrong">;
export function choosesValue(decision: ErrorDecision): decision is ValueChoosingDecision {
  return decision === "researchers_correct" || decision === "all_wrong";
}

/**
 * Decisões que levam `value` ao RPC: as de `choosesValue`, com o valor do
 * seletor, e "Ambos corretos", com o valor comum que a prévia do servidor
 * mostrou (`both_correct_value`). Em "Ambos corretos" o RPC recalcula o valor
 * e recusa a decisão quando o enviado não é ele (#758).
 */
export function carriesValue(decision: ErrorDecision): boolean {
  return choosesValue(decision) || decision === "both_correct";
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

/**
 * O que "Ambos corretos" grava no gabarito, calculado pelo banco sobre o
 * contexto conferido (`both_correct_value`, a mesma função que
 * `set_error_resolution` usa ao gravar): o valor comum, ou `null` quando o
 * veredito continua valendo (#758). `""` e `[]` são valor.
 */
export type BothCorrectPreview = { value: unknown } | null;

export const errorResolutionInputSchema = z.object({
  decision: errorDecisionSchema,
  context: errorResolutionContextSchema,
  expected: z.object({ id: z.string(), resolved_at: z.string() }).nullable(),
  note: z.string().optional(),
  /**
   * O valor que vai ao gabarito nas decisões de `carriesValue`: nas de
   * `choosesValue`, escolhido pelo revisor nas opções atuais do campo (#733),
   * e a RPC valida o domínio; em "Ambos corretos", o valor comum da prévia,
   * que a RPC recalcula e confere (#758).
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
  /**
   * Coluna `approved_value`: obrigatória nas decisões de `choosesValue` e
   * opcional em "Ambos corretos", que a tem quando gravou o valor comum
   * (CHECK `error_resolution_value_by_decision`). `""` e `[]` são valor (o
   * branco de condicional); ausência é `null`.
   */
  approved_value?: unknown;
}

export type EffectiveErrorResolution =
  | { status: "open" }
  | { status: "legacy" }
  | { status: "stale" }
  | { status: "discussion" }
  /**
   * "Ambos corretos" sem valor comum: nenhum valor é aprovado, o gabarito
   * continua sendo o veredito da arbitragem. `llmValue` é a resposta do LLM,
   * que passa a contar como correta ao lado dele. `verdictValue` só existe na
   * auto-revisão, cujo veredito (a resposta humana do contexto) não chega ao
   * export nem ao Gabarito por outra via; na Comparação quem o traz é a
   * própria review. Com o valor comum, "Ambos corretos" é `approved`.
   */
  | { status: "upheld"; llmValue: unknown; verdictValue?: unknown }
  | { status: "approved"; value: unknown; isLlmError: boolean };

// A decisão só vale enquanto as fontes em que ela se apoiou seguem iguais.
function contextIsCurrent(row: ErrorResolutionRow, context: ErrorResolutionContext): boolean {
  return !!row.current_context &&
    context.project_id === row.project_id && context.document_id === row.document_id &&
    context.field_name === row.field_name &&
    stableStringify(context) === stableStringify(row.current_context);
}

function upheldResolution(context: ErrorResolutionContext): EffectiveErrorResolution {
  if (!context.llm_value.present) return { status: "stale" };
  const fromAutoReview = context.source.kind === "auto_revisao" && context.human_value.present;
  return { status: "upheld", llmValue: context.llm_value.value,
    ...(fromAutoReview ? { verdictValue: context.human_value.value } : {}) };
}

/** Se a linha gravou valor próprio em `approved_value` (`""` e `[]` contam). */
function hasApprovedValue(row: Pick<ErrorResolutionRow, "approved_value">): boolean {
  return row.approved_value !== undefined && row.approved_value !== null;
}

// "Ambos corretos" com o valor comum (#758): o veredito ficou para trás, e os
// pesquisadores atuais e o LLM concordam no valor que vai ao gabarito. Nenhum
// dos lados errou, então não é erro do LLM, e "Erro humano" deixa de ser o
// único jeito de gravar esse valor.
function bothCorrectResolution(row: ErrorResolutionRow, context: ErrorResolutionContext): EffectiveErrorResolution {
  return hasApprovedValue(row)
    ? { status: "approved", value: row.approved_value, isLlmError: false }
    : upheldResolution(context);
}

// "Erro do LLM" e "Todos errados" aprovam o valor que o revisor escolheu, não
// a resposta de um codificador: `human_value` fica no contexto só como âncora
// de invalidação (#733). Linha sem coluna é anterior à migration e não é
// aprovável até ser confirmada de novo.
function chosenValueResolution(row: ErrorResolutionRow): EffectiveErrorResolution {
  if (!hasApprovedValue(row)) return { status: "stale" };
  return { status: "approved", value: row.approved_value, isLlmError: true };
}

// Pergunta condicional cujo gatilho não a aciona fica sem a chave em
// `answers`, na codificação humana e no LLM. Nela, e só nela, "em branco" é
// resposta: o revisor pode aprová-la como gabarito, e o LLM que deixou o campo
// de fora pode estar certo. O vazio gravado tem uma forma só por tipo, a que
// `set_error_resolution` aceita; JSON null não serve porque o cliente o lê
// igual à coluna nula, que significa decisão sem valor.
export function isConditionalField(field: Pick<PydanticField, "condition">): boolean {
  return field.condition != null;
}

export function blankAnswerFor(field: Pick<PydanticField, "type">): "" | string[] {
  return field.type === "multi" ? [] : "";
}

/** Se a resposta está em branco em qualquer das formas que chegam do banco. */
export function isBlankAnswer(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  return Array.isArray(value) && value.length === 0;
}

function isCanonicalBlank(field: Pick<PydanticField, "type">, value: unknown): boolean {
  return field.type === "multi" ? Array.isArray(value) && value.length === 0 : value === "";
}

// O contexto da decisão traz a definição do campo como JSON cru.
function conditionalBlank(definition: unknown): "" | string[] | undefined {
  if (!isSubfieldRecord(definition) || !isSubfieldRecord(definition.condition)) return undefined;
  return blankAnswerFor({ type: definition.type === "multi" ? "multi" : "text" });
}

/** Se o LLM deixou de fora um campo condicional, o que conta como resposta "em branco". */
export function llmAnswersBlank(context: ErrorResolutionContext): boolean {
  return !context.llm_value.present && conditionalBlank(context.field_definition) !== undefined;
}

/**
 * Se a resposta do LLM está em branco em qualquer forma: sem a chave, ou com
 * `null`, `""` ou `[]`. Nesse caso o branco não pode ser gravado como erro do
 * LLM (`set_error_resolution` recusa), porque o Gabarito o marca como certo.
 */
export function llmValueIsBlank(context: ErrorResolutionContext): boolean {
  return !context.llm_value.present || isBlankAnswer(context.llm_value.value);
}

// "Erro humano" aprova a resposta do LLM. Sem o campo nela, só há o que
// aprovar quando o campo é condicional: o LLM respondeu "em branco".
function llmCorrectResolution(context: ErrorResolutionContext): EffectiveErrorResolution {
  if (context.llm_value.present) return { status: "approved", value: context.llm_value.value, isLlmError: false };
  const blank = conditionalBlank(context.field_definition);
  return blank === undefined ? { status: "stale" } : { status: "approved", value: blank, isLlmError: false };
}

export function effectiveErrorResolution(row: ErrorResolutionRow | undefined): EffectiveErrorResolution {
  if (!row) return { status: "open" };
  if (row.decision === null) return { status: "legacy" };
  const context = row.context;
  if (!context || !contextIsCurrent(row, context)) return { status: "stale" };
  if (row.decision === "discussion") return { status: "discussion" };
  if (row.decision === "both_correct") return bothCorrectResolution(row, context);
  if (choosesValue(row.decision)) return chosenValueResolution(row);
  return llmCorrectResolution(context);
}

/**
 * Se a decisão depende do veredito que a originou para valer. "Erro humano",
 * "Erro do LLM" e "Todos errados" gravam valor próprio (a resposta do LLM ou
 * `approved_value`), e "Ambos corretos" também quando gravou o valor comum:
 * são um julgamento novo sobre as respostas e a pergunta atuais, que o
 * contexto já confere, e valem mesmo que o veredito da fonte tenha perdido a
 * validade. "Ambos corretos" sem valor e "Em discussão" não gravam valor, e o
 * gabarito continua sendo o veredito da fonte. A lista é a das decisões com
 * valor para que um tipo novo nasça exigindo a fonte; a cópia SQL é o último
 * argumento de `llm_error_context` em `read_error_resolutions`
 * (20260927140000_both_correct_common_value.sql).
 */
export function decisionDependsOnSource(row: Pick<ErrorResolutionRow, "decision" | "approved_value">): boolean {
  const { decision } = row;
  if (decision === "both_correct") return !hasApprovedValue(row);
  return decision !== "llm_correct" && decision !== "researchers_correct" && decision !== "all_wrong";
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

// Opção de formulário carrega espaço final; o valor gravado nem sempre. Fora
// das opções só cabe o "Outro: <texto>" de campo que o permite, o mesmo
// domínio de `isAllowedOption`: sem isso o seletor abria sem o complemento que
// o veredito trazia, e confirmar gravava a resposta pela metade.
function currentOption(field: PydanticField, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const option = field.options?.find((candidate) => candidate.trim() === value.trim());
  return option ?? (isAllowedOption(field, value) ? value : undefined);
}

function prefillSingle(field: PydanticField, value: unknown): string | undefined {
  return currentOption(field, value);
}

// Na ordem das opções do formulário, com os "Outro" ao fim.
function prefillMulti(field: PydanticField, value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = new Set(value.map((item) => currentOption(field, item)).filter((item): item is string => item !== undefined));
  // No máximo um "Outro": o controle só exibe o primeiro, e um segundo iria
  // ao gabarito sem nunca ter aparecido na tela.
  const chosen = [...(field.options ?? []).filter((option) => kept.has(option)),
    ...[...kept].filter((item) => !field.options?.includes(item)).slice(0, 1)];
  return chosen.length > 0 ? chosen : undefined;
}

// As opções que um veredito de `multi` marca: chaves `true` do JSON
// `{opção: bool}` (ver `formatVerdict` e `resolutionVerdict`).
function verdictMultiItems(verdict: string): string[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(verdict); } catch { return undefined; }
  if (!isSubfieldRecord(parsed)) return undefined;
  return Object.entries(parsed).filter(([, v]) => v === true).map(([k]) => k);
}

/**
 * Se a fonte do valor inicial de um `multi` marca algo que não cabe mais no
 * formulário. O seletor pré-marca só o que cabe, e sem este aviso o revisor
 * confirmaria um subconjunto achando que ratifica a resposta inteira. A fonte
 * é a mesma de `prefillFromVerdict` e do seu fallback, na mesma ordem: os
 * itens do JSON do veredito; quando o veredito é texto renderizado (um `multi`
 * votado em card, o snapshot humano da auto-revisão), a forma crua.
 */
export function prefillLosesItems(field: PydanticField, verdict: string, rawValue?: unknown): boolean {
  if (field.type !== "multi") return false;
  const items = verdictMultiItems(verdict) ?? (Array.isArray(rawValue) ? rawValue : []);
  const kept = prefillMulti(field, items) ?? [];
  return kept.length < new Set(items.map((item) => (typeof item === "string" ? item.trim() : item))).size;
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
    // A resposta é o array das opções que o veredito marca.
    const items = verdictMultiItems(verdict);
    return items ? prefillFromValue(field, items) : undefined;
  }
  if (hasSubfields(field)) {
    // O veredito é o texto renderizado dos subcampos; reconstruir o objeto
    // seria inventar evidência. A sentinela é a única forma reconhecível.
    return text === NOT_INFORMED ? NOT_INFORMED : undefined;
  }
  return prefillFromValue(field, text === "" ? undefined : verdict);
}

/**
 * Se o seletor abre com "Deixar em branco" marcado. Só em pergunta
 * condicional, e com a mesma precedência de `initialValue` no diálogo: o
 * valor aprovado numa decisão anterior do mesmo tipo (`previous`) vence; em
 * "Erro do LLM", depois dele vem o veredito, e um veredito vazio (texto em
 * branco, ou `multi` sem opção marcada) é a arbitragem dizendo "em branco".
 * "Todos errados" rejeita o veredito, então não parte dele.
 */
export function startsBlank(field: PydanticField, decision: ValueChoosingDecision, verdict: string, previous: unknown): boolean {
  if (!isConditionalField(field)) return false;
  if (previous !== undefined) return isBlankAnswer(previous);
  if (decision === "all_wrong") return false;
  if (field.type === "multi" && verdict.trim() !== "") return verdictMultiItems(verdict)?.length === 0;
  return verdict.trim() === "";
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
 * Se o valor do seletor basta para ir ao gabarito. Segue a validação de
 * `set_error_resolution` e, fora das duas regras do último parágrafo, é igual
 * a ela ou mais restritiva. É mais restritiva em quatro pontos:
 * - grupo de subcampos: a RPC aceita qualquer texto não vazio no lugar do
 *   registro, e aqui só entram o registro de subcampos ou `NOT_INFORMED`
 *   (`hasGroupValue`);
 * - texto simples: "Outro: " sem complemento não conta como preenchido, e a
 *   RPC o aceita;
 * - branco: aqui se mede pelo `trim()` do JS, que tira também tabulação e
 *   NBSP, e o `btrim` da RPC só tira o espaço comum;
 * - data: parte completa fora do intervalo, como dia 32, mês 13 ou ano 0999,
 *   fica de fora (`arePartsValid`), e a RPC a aceita.
 *
 * Duas regras da RPC não moram aqui. A data só de dígitos (até 2/2/4) é
 * garantida pelo controle de data do FieldRenderer: um valor pré-carregado
 * como "ab/cd/efgh" passa nesta função e a RPC o recusa.
 * E a recusa do branco quando o LLM também deixou em branco depende do
 * contexto, e fica em `canConfirmValue`, no diálogo.
 */
export function hasResolutionValue(field: PydanticField, value: unknown): boolean {
  if (isConditionalField(field) && isCanonicalBlank(field, value)) return true;
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
