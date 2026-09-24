// Conjunto de comparação de um documento: a regra única que decide quais
// respostas contam e onde elas divergem. Fila (compare-queue.ts), fecho
// (compare-sync.ts) e gatilho (auto-comparison.ts) consomem este módulo; cada
// um continua dono da própria busca no Supabase e entrega aqui as linhas já
// carregadas.
//
// Definições (este cabeçalho é a fonte delas):
//
// - Respostas que contam: as que passam em `responseQualifiesForVersion`
//   (compare-version.ts) sob o piso de versão recebido. Isso inclui a régua de
//   completude: `is_partial` é o veredito dela sobre o conjunto gravado, no
//   momento da escrita e contra o carimbo per-campo, então uma obrigatória
//   criada depois do envio não tira a codificação do conjunto. Não há uma
//   segunda régua aqui; reaplicar `isCodingComplete` contra o schema de hoje
//   fazia o gatilho descartar quem a tela mostrava.
// - Humanos distintos: respondentes humanos contados por `respondentKey`, não
//   por linha.
// - Divergência a resolver: os campos em que as respostas que contam divergem,
//   LLM incluído sempre que qualifica. É o que a fila mostra e o que o fecho
//   exige resolvido; as duas leituras vêm daqui para que resolver tudo o que a
//   tela mostra feche o parecer (#217/#218).
// - Divergência que dispara: a mesma conta, mas com o LLM só quando a regra
//   do projeto o põe no disparo (`compare_llm`, ou `compare_humans` com
//   `comparison_includes_llm`). Com a opção desligada, o LLM não abre a
//   comparação, mas a divergência dele segue na de resolver: é o que o texto
//   da opção promete em config/rules/RulesForm.tsx.
//
// Lentes da fila (`since`, `respondent`, piso de versão escolhido na URL) não
// entram aqui como regra: o chamador filtra antes, e elas não redefinem
// "concluído".

import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import {
  responseQualifiesForVersion,
  type ProjectVersionContext,
  type SchemaVersion,
  type VersionedResponse,
} from "@/lib/compare-version";
import type { EquivalencePair } from "@/lib/equivalence";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import { respondentKey } from "@/components/compare/compare-types";

// Modos de automação que materializam uma comparação para um revisor terceiro.
// auto_review_llm e none não têm disparo de comparação.
export type ComparisonMode = "compare_humans" | "compare_llm";

export interface ComparisonCandidate extends VersionedResponse {
  id: string;
  respondent_id: string | null;
  answers: Record<string, unknown> | null;
  answer_field_hashes: AnswerFieldHashes | null;
}

export interface ComparisonSetInput<R extends ComparisonCandidate> {
  fields: PydanticField[];
  // Humanas e LLM do documento, numa lista só.
  responses: readonly R[];
  minVersion: SchemaVersion | null;
  versionCtx: ProjectVersionContext;
  equivalencesByField?: Map<string, EquivalencePair[]>;
}

export interface TriggerRule {
  mode: ComparisonMode;
  minResponsesForComparison: number | null | undefined;
  comparisonIncludesLlm: boolean | null | undefined;
}

export type TriggerVerdict =
  | {
      kind: "insufficient";
      reason: "few_humans" | "no_llm" | "needs_two_responses";
      humans: number;
      minHumans: number;
    }
  | { kind: "consensus" }
  | { kind: "divergent"; divergentFields: string[] };

export interface ComparisonSet<R extends ComparisonCandidate> {
  readonly counted: R[];
  readonly humanRespondentCount: number;
  readonly toResolve: string[];
  trigger(rule: TriggerRule): TriggerVerdict;
}

// Piso de humanos do disparo. Exportado porque a fase leve da varredura de
// backlog (auto-comparison.ts) pré-seleciona candidatos por esta mesma conta
// antes de buscar `answers`.
export function minimumHumansToTrigger(rule: Omit<TriggerRule, "comparisonIncludesLlm">): number {
  return rule.mode === "compare_humans" ? (rule.minResponsesForComparison ?? 2) : 1;
}

function llmEntersTrigger(rule: TriggerRule): boolean {
  return rule.mode === "compare_llm" || rule.comparisonIncludesLlm === true;
}

function insufficientReason(
  rule: TriggerRule,
  humans: number,
  minHumans: number,
  hasLlm: boolean,
  triggeringCount: number,
): Extract<TriggerVerdict, { kind: "insufficient" }>["reason"] | null {
  if (humans < minHumans) return "few_humans";
  if (rule.mode === "compare_llm" && !hasLlm) return "no_llm";
  if (triggeringCount < 2) return "needs_two_responses";
  return null;
}

function divergence(
  fields: PydanticField[],
  responses: readonly ComparisonCandidate[],
  equivalencesByField: Map<string, EquivalencePair[]> | undefined,
): string[] {
  return computeDivergentFieldNames(
    fields,
    responses.map((r) => ({
      id: r.id,
      answers: r.answers ?? {},
      answerFieldHashes: r.answer_field_hashes ?? undefined,
    })),
    equivalencesByField,
  );
}

export function comparisonSet<R extends ComparisonCandidate>(
  input: ComparisonSetInput<R>,
): ComparisonSet<R> {
  const { fields, minVersion, versionCtx, equivalencesByField } = input;
  const counted = input.responses.filter((r) =>
    responseQualifiesForVersion(r, minVersion, versionCtx),
  );
  const humans = counted.filter((r) => r.respondent_type === "humano");
  const llm = counted.find((r) => r.respondent_type === "llm") ?? null;
  const humanRespondentCount = new Set(humans.map(respondentKey)).size;
  // Sob demanda e memorizada: a fila descarta boa parte dos documentos pelos
  // limiares de cobertura antes de precisar da divergência, e não deve pagar
  // o cálculo deles.
  let toResolve: string[] | undefined;
  const resolve = () =>
    (toResolve ??= counted.length < 2 ? [] : divergence(fields, counted, equivalencesByField));

  return {
    counted,
    humanRespondentCount,
    get toResolve() {
      return resolve();
    },
    trigger(rule) {
      const minHumans = minimumHumansToTrigger(rule);
      const triggering = llmEntersTrigger(rule) ? counted : humans;
      const reason = insufficientReason(rule, humanRespondentCount, minHumans, llm !== null, triggering.length);
      if (reason) return { kind: "insufficient", reason, humans: humanRespondentCount, minHumans };
      // Mesmo tamanho = mesmo conjunto (sem LLM, ou LLM no disparo): reaproveita
      // a divergência a resolver em vez de recalcular.
      const divergentFields =
        triggering.length === counted.length ? resolve() : divergence(fields, triggering, equivalencesByField);
      return divergentFields.length === 0 ? { kind: "consensus" } : { kind: "divergent", divergentFields };
    },
  };
}
