// A fila conserva decisões para reabertura; numerador e denominador vêm de reviewedEntries.
//
// Há DUAS fontes de veredito sobre acerto/erro do LLM, e as duas contam:
//
//   Fonte A — Comparação (`reviews`): o revisor escolheu, entre as respostas
//   do documento, qual é o gabarito. O LLM acertou se a resposta dele cai na
//   mesma classe de equivalência da escolhida.
//
//   Fonte B — Auto-revisão (`field_reviews`, lida via a view `final_answers`):
//   o próprio codificador confronta a sua resposta com a do LLM, com
//   arbitragem quando ele contesta. A RPC desse fluxo nunca escreve em
//   `reviews`, então antes desta métrica os projetos em `auto_review_llm`
//   apareciam sem taxa nenhuma.
//
// Um projeto que trocou de `automation_mode` tem histórico nas duas tabelas
// para o mesmo (documento, campo) — não há constraint cruzada impedindo — daí
// a deduplicação em `pickWinner`.
import { normalizeForComparison } from "@/lib/utils";
import {
  buildResponseGroupKeys,
  filterCurrentEquivalencePairs,
  type EquivalencePair,
} from "@/lib/equivalence";
import { isFieldApplicable } from "@/lib/compare-divergence";
import {
  multiSelectionSets,
  multiSelectionsAgree,
} from "@/lib/compare-multi-options";
import { isCodingComplete } from "@/lib/coding-completeness";
import { resolveTarget } from "@/lib/pydantic-field";
import { formatAnswer } from "@/lib/reviews/queries";
import { formatCardAnswer } from "@/lib/verdict-display";
import { pickValidCellReviews, reviewIsValid } from "@/lib/review-validity";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import { applicableErrorResolution, isBlankAnswer, type EffectiveErrorResolution, type ErrorResolutionRow } from "@/lib/error-resolution";

/** De qual das duas fontes o veredito veio. A UI usa para decidir affordances. */
export type LlmErrorSource = "comparacao" | "auto_revisao";

export interface LlmError {
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  llmAnswer: string;
  llmJustification: string | null;
  chosenVerdict: string;
  /**
   * A forma crua do veredito em `responses.answers`, para o seletor de
   * "Erro do LLM" quando o texto de `chosenVerdict` não casa com as opções:
   * na Comparação, a resposta que a arbitragem escolheu enquanto ela ainda
   * é o veredito (um voto em card grava `multi` como "A, C", que não se
   * reconstrói do texto); se o codificador a editou depois, ela não é mais o
   * veredito e fica ausente. Na auto-revisão, o snapshot humano. Ausente na
   * ressurreição de decisão da Comparação: ali o contexto só tem a resposta
   * de um codificador, que não é o veredito (#733).
   */
  chosenValue?: unknown;
  reviewerComment: string | null;
  resolvedAt: string | null;
  reviewedAt: string;
  schemaVersion: string | null;
  llmResponseId: string;
  chosenResponseId: string | null;
  source: LlmErrorSource;
  sourceId?: string | null;
  resolution?: ErrorResolutionRow;
}

// Todo (doc, campo) que o LLM respondeu e que já tem veredito humano — de
// qualquer das duas fontes — após as mesmas supressões aplicadas a `errors`.
// A UI usa como denominador, para que a taxa respeite os filtros ativos.
export interface ReviewedEntry {
  documentId: string;
  documentTitle: string;
  fieldName: string;
  schemaVersion: string | null;
  reviewedAt: string;
  isError: boolean;
  isPending?: boolean;
}

/* ── Formatos crus de entrada (colunas do banco, snake_case) ── */

export interface MetricsResponse {
  id: string;
  respondent_name?: string | null;
  document_id: string;
  respondent_type: "humano" | "llm";
  is_latest: boolean;
  answers: Record<string, unknown> | null;
  justifications: Record<string, string> | null;
  answer_field_hashes?: AnswerFieldHashes | null;
  created_at: string;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
}

export interface MetricsReview {
  id: string;
  document_id: string;
  field_name: string;
  verdict: string;
  chosen_response_id: string | null;
  comment: string | null;
  created_at: string;
  /** `reviews.field_hash`: o hash do campo quando a arbitragem foi feita. */
  field_hash: string | null;
}

// Os valores que o `CASE` de `final_answers` emite, e nada além deles. União
// literal em vez de `string` de propósito: com `string`, um estado terminal
// novo (ou renomeado) na view cairia no ramo "pendente" e sumiria em silêncio
// do numerador E do denominador — sem erro, sem log e sem teste vermelho. Assim
// o drift vira erro de compilação em `classifyAutoReview`.
export type AutoReviewProvenance =
  | "consenso"
  | "auto_corrigido"
  | "equivalente"
  | "ambiguo"
  | "arbitrado"
  | "aguarda_reconciliacao"
  | "aguarda_auto_revisao"
  | "aguarda_arbitragem";

// Linha da view `final_answers` (uma por documento com LLM × campo do schema).
export interface MetricsFinalAnswer {
  field_review_id?: string | null;
  document_id: string;
  field_name: string;
  provenance: AutoReviewProvenance;
  final_verdict: string | null;
  self_reviewed_at: string | null;
  final_decided_at: string | null;
  human_response_id: string | null;
  llm_response_id: string | null;
  human_answer_snapshot: unknown;
  llm_answer_snapshot: unknown;
  /** Texto que o arbitrador escreveu ao decidir; exibido como "Comentário do revisor". */
  arbitrator_comment: string | null;
}

/**
 * Decisão gravada que saiu da fila por ter perdido a validade: ou o contexto
 * mudou (`stale`), ou ela depende do veredito de origem e ele não vale mais.
 */
export interface LapsedDecision {
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  decision: ErrorResolutionRow["decision"];
  resolvedAt: string;
}

export interface MetricsEquivalence extends EquivalencePair {
  document_id: string;
  field_name: string;
}

export interface LlmErrorMetricsInput {
  fields: PydanticField[];
  /**
   * `projects.automation_mode`. A fonte de auto-revisão só é lida em
   * 'auto_review_llm': `field_reviews` não é materializado nos outros modos, e
   * a view devolveria 'consenso' — que ali significa apenas "este projeto não
   * usa auto-revisão" — para todo campo de todo documento.
   */
  automationMode: string | null;
  /**
   * Só os documentos ATIVOS do projeto. As chaves, e não só os valores, são
   * consumidas: elas definem o conjunto de documentos que a métrica mede.
   */
  documentTitles: Map<string, string>;
  /** Todas as responses do projeto, de todas as rodadas e respondentes. */
  responses: MetricsResponse[];
  /**
   * Todas as reviews do projeto, de qualquer rodada e revisor. Quais valem e
   * qual vale por célula é decidido aqui, pela regra única de
   * `review-validity.ts`: a rodada não entra nela, a versão da pergunta sim.
   */
  reviews: MetricsReview[];
  /** Já filtradas por projeto; vazio quando o projeto não usa auto-revisão. */
  finalAnswers: MetricsFinalAnswer[];
  /** Já filtradas por `superseded_at IS NULL`, COM as colunas de snapshot. */
  equivalences: MetricsEquivalence[];
  errorResolutions: Map<string, ErrorResolutionRow>;
}

// Candidato antes da deduplicação entre as duas fontes.
interface Candidate {
  documentId: string;
  fieldName: string;
  /** Quando o humano decidiu. `null` em consenso (ninguém decidiu nada). */
  decidedAt: string | null;
  isError: boolean;
  error: LlmError | null;
  entry: ReviewedEntry;
}

function formatSchemaVersion(response: {
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
}): string | null {
  const { schema_version_major, schema_version_minor, schema_version_patch } =
    response;
  if (
    schema_version_major == null ||
    schema_version_minor == null ||
    schema_version_patch == null
  )
    return null;
  return `${schema_version_major}.${schema_version_minor}.${schema_version_patch}`;
}

// Campos sobre os quais faz sentido perguntar se o LLM acertou: os que o LLM
// responde E o humano revisa. Os três excluídos saem por razões distintas —
// `none` e `llm_only` o coordenador tirou da superfície de revisão humana, e
// `human_only` o LLM sequer recebe (`llm_runner._visible_fields` o descarta).
//
// `human_only` é o mais traiçoeiro dos três na fonte de auto-revisão: sem
// resposta do LLM não há divergência, sem divergência `computeDivergentFieldNames`
// não gera linha em `field_reviews`, e sem linha a view emite 'consenso' — um
// acerto fabricado por campo `human_only` por documento codificado, sempre no
// sentido de deflacionar a taxa.
//
// O default de `target` sai de `resolveTarget`, nunca de um `!== x` local
// (regra (c2) do CLAUDE.md).
export function isMeasurableField(
  field: PydanticField | undefined,
): field is PydanticField {
  if (!field) return false;
  const target = resolveTarget(field.target);
  return target !== "none" && target !== "llm_only" && target !== "human_only";
}

// "O LLM acertou este campo?" a partir da proveniência da auto-revisão. O mapa
// espelha o `CASE` da view `final_answers`, e o `satisfies` é o gate de drift:
// acrescentar um estado à view sem classificá-lo aqui não compila.
const AUTO_REVIEW_OUTCOME = {
  // Sem linha em `field_reviews`: humano e LLM concordaram na codificação, e o
  // campo nunca entrou na fila de auto-revisão.
  consenso: "acerto",
  // O codificador reconheceu que errou e o LLM estava certo.
  auto_corrigido: "acerto",
  // Respostas diferentes no texto, mesma coisa no conteúdo — o análogo exato do
  // "semelhantes" da Comparação, e como lá, não é erro do LLM.
  equivalente: "acerto",
  // O único caso em que a proveniência sozinha não decide: quem decide é
  // `final_verdict`.
  arbitrado: "depende_do_veredito",
  // 'ambiguo' é terminal mas não produz gabarito: fica fora do numerador E do
  // denominador, como já acontece com o veredito "ambiguo" da Comparação. Os
  // 'aguarda_*' são pendências, não acertos.
  ambiguo: "pendente",
  aguarda_reconciliacao: "pendente",
  aguarda_auto_revisao: "pendente",
  aguarda_arbitragem: "pendente",
} satisfies Record<
  AutoReviewProvenance,
  "acerto" | "pendente" | "depende_do_veredito"
>;

function classifyAutoReview(
  row: MetricsFinalAnswer,
): "acerto" | "erro" | "pendente" {
  // A indexação é total pelo tipo; o `undefined` só aparece se o banco emitir
  // um valor fora da união, e aí "pendente" é a leitura conservadora.
  const outcome: string | undefined = AUTO_REVIEW_OUTCOME[row.provenance];
  if (outcome !== "depende_do_veredito") {
    return outcome === "acerto" ? "acerto" : "pendente";
  }
  return row.final_verdict === "humano" ? "erro" : "acerto";
}

// Vence a decisão mais recente. Consenso não é decisão de ninguém e perde para
// qualquer veredito explícito, de qualquer das fontes; empate mantém o
// incumbente, o que torna o resultado estável dada a ordem de inserção.
function beats(candidate: Candidate, incumbent: Candidate): boolean {
  if (candidate.decidedAt && !incumbent.decidedAt) return true;
  if (!candidate.decidedAt) return false;
  return candidate.decidedAt > incumbent.decidedAt!;
}

// Contexto derivado uma vez e compartilhado pelas duas fontes.
interface MetricsContext {
  fieldMap: Map<string, PydanticField>;
  isActiveDocument: (docId: string) => boolean;
  titleOf: (docId: string) => string;
  resolvedAtOf: (docId: string, fieldName: string) => string | null;
  responsesByDoc: Map<string, MetricsResponse[]>;
  responseById: Map<string, MetricsResponse>;
  llmLatestByDoc: Map<string, MetricsResponse>;
  /** Ids das reviews que valem como gabarito (`review-validity.ts`). */
  validReviewIds: ReadonlySet<string>;
  /** Classes de equivalência por (documento, campo), memoizadas. */
  groupKeysFor: (docId: string, fieldName: string) => Map<string, string>;
  /** `isCodingComplete` da response, memoizado por id. */
  codingIsComplete: (response: MetricsResponse) => boolean;
}

function buildContext(input: LlmErrorMetricsInput): MetricsContext {
  const { fields, documentTitles, responses, equivalences, errorResolutions } = input;
  const fieldMap = new Map(fields.map((f) => [f.name, f]));

  const responsesByDoc = new Map<string, MetricsResponse[]>();
  const responseById = new Map<string, MetricsResponse>();
  const llmLatestByDoc = new Map<string, MetricsResponse>();
  for (const response of responses) {
    const bucket = responsesByDoc.get(response.document_id);
    if (bucket) bucket.push(response);
    else responsesByDoc.set(response.document_id, [response]);
    responseById.set(response.id, response);
    if (response.respondent_type === "llm" && response.is_latest) {
      llmLatestByDoc.set(response.document_id, response);
    }
  }

  const equivByDocField = new Map<string, Map<string, MetricsEquivalence[]>>();
  for (const pair of equivalences) {
    let byField = equivByDocField.get(pair.document_id);
    if (!byField) {
      byField = new Map();
      equivByDocField.set(pair.document_id, byField);
    }
    const bucket = byField.get(pair.field_name);
    if (bucket) bucket.push(pair);
    else byField.set(pair.field_name, [pair]);
  }

  // Memoizado: um documento com muitos campos revisados repetiria o union-find
  // por campo à toa.
  const groupKeyCache = new Map<string, Map<string, string>>();
  const groupKeysFor = (docId: string, fieldName: string) => {
    const cacheKey = `${docId}:${fieldName}`;
    const cached = groupKeyCache.get(cacheKey);
    if (cached) return cached;

    // Todas as responses do documento entram, inclusive rodadas anteriores:
    // `chosen_response_id` pode apontar para uma resposta que não é mais a
    // `is_latest`, e é justamente por essas que o fecho transitivo passa.
    const items = (responsesByDoc.get(docId) ?? []).map((response) => ({
      id: response.id,
      answer: response.answers?.[fieldName],
    }));
    const pairs = filterCurrentEquivalencePairs(
      items,
      equivByDocField.get(docId)?.get(fieldName) ?? [],
      (item) => item.answer,
    );
    const groupKeys = buildResponseGroupKeys(items, pairs, (item) =>
      normalizeForComparison(item.answer),
    );
    groupKeyCache.set(cacheKey, groupKeys);
    return groupKeys;
  };

  // Memoizado por response: a fonte de auto-revisão pergunta uma vez por
  // (documento, campo), mas completude é propriedade da RESPONSE — só os checks
  // de aplicabilidade dependem do campo. Sem o cache, um projeto de 5000
  // documentos × 40 campos reavaliava `isCodingComplete` (que por sua vez itera
  // todos os campos) centenas de milhares de vezes por render.
  const completeCache = new Map<string, boolean>();
  const codingIsComplete = (response: MetricsResponse) => {
    const cached = completeCache.get(response.id);
    if (cached !== undefined) return cached;
    const complete = isCodingComplete(
      fields,
      response.answers ?? {},
      response.answer_field_hashes ?? undefined,
    );
    completeCache.set(response.id, complete);
    return complete;
  };

  return {
    fieldMap,
    isActiveDocument: (docId) => documentTitles.has(docId),
    titleOf: (docId) => documentTitles.get(docId) || docId,
    resolvedAtOf: (docId, fieldName) =>
      errorResolutions.get(`${docId}:${fieldName}`)?.resolved_at ?? null,
    responsesByDoc,
    responseById,
    llmLatestByDoc,
    validReviewIds: new Set(
      input.reviews.filter((review) => reviewIsValid(review, fieldMap.get(review.field_name))).map((review) => review.id),
    ),
    groupKeysFor,
    codingIsComplete,
  };
}

// A response que a arbitragem escolheu, por id e no documento da própria
// review. Desde 20260924110000 a FK de `chosen_response_id` é composta com
// `document_id`, e o banco recusa response de outro documento. A guarda fica
// como defesa barata: exibir a resposta de outro documento seria pior que não
// ter nenhuma, e ela não depende de a migration estar aplicada no banco que o
// código lê.
function chosenResponseOf(review: MetricsReview, ctx: MetricsContext): MetricsResponse | undefined {
  if (!review.chosen_response_id) return undefined;
  const response = ctx.responseById.get(review.chosen_response_id);
  return response?.document_id === review.document_id ? response : undefined;
}

type VerdictMatcher = (answer: unknown) => boolean;

// Uma resposta crua bate com o veredito quando as duas estão em branco, ou
// quando o veredito é a resposta na forma crua ou na forma que o card de
// Comparação exibe, que é o que o voto no card grava (data parcial com "—",
// subcampos unidos por ", "). A normalização é a de sempre:
// `normalizeForComparison`, que ignora caixa, acento e espaço.
function textVerdictMatcher(verdict: string): VerdictMatcher {
  const target = normalizeForComparison(verdict);
  return (answer) =>
    (isBlankAnswer(answer) && isBlankAnswer(verdict)) ||
    normalizeForComparison(answer) === target ||
    normalizeForComparison(formatCardAnswer(answer)) === target;
}

// `multi` tem semântica de CONJUNTO de opções, e é assim que
// `computeDivergentFieldNames` o compara: ["a","b"] e ["b","a"] concordam. O
// veredito votado na grade é o JSON `{opção: bool}`; o votado em card (quando
// a pergunta ainda era `single`) é o texto "A, C", lido como uma opção inteira
// ou como partes separadas por ", ".
function multiVerdictMatcher(verdict: string, options: string[]): VerdictMatcher {
  const selection = verdictSelection(verdict, options);
  return (answer) => multiSelectionsAgree(options, multiSelectionSets([answer, selection]));
}

function verdictSelection(verdict: string, options: string[]): string[] {
  const text = verdict.trim();
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.entries(parsed).flatMap(([option, marked]) => (marked === true ? [option] : []));
      }
    } catch {
      // Não é JSON: segue como texto.
    }
  }
  if (text === "") return [];
  return options.includes(text) ? [text] : text.split(", ").map((part) => part.trim());
}

function verdictMatcher(review: MetricsReview, field: PydanticField): VerdictMatcher {
  return field.type === "multi" && !!field.options?.length
    ? multiVerdictMatcher(review.verdict, field.options)
    : textVerdictMatcher(review.verdict);
}

// O LLM errou este campo, na leitura da Comparação? Errou sse o valor dele
// difere do VALOR do veredito, e não da resposta atual de quem a arbitragem
// escolheu: o codificador pode ter editado a resposta depois da arbitragem, e
// o Gabarito e o export leem o veredito. A exceção é o par "=" vigente: se ele
// liga (direto ou por transitividade, pelo union-find de
// `filterCurrentEquivalencePairs`, que já descarta par cujo snapshot não bate
// com a resposta atual) a resposta do LLM a uma resposta cujo valor atual é o
// do veredito, o revisor declarou as duas a mesma resposta.
//
// Em `multi` a métrica se separa de `computeDivergentFieldNames` num ponto, de
// propósito: aqui o par marcado pelo revisor vale, e lá não, porque a
// Comparação não oferece par em campo `multi` e o campo segue divergente até
// ser arbitrado.
function comparisonIsError(
  review: MetricsReview,
  field: PydanticField,
  llmResponse: MetricsResponse,
  ctx: MetricsContext,
): boolean {
  // O revisor escolheu a própria resposta do LLM. Resposta de LLM não é
  // editada no lugar: rodada nova grava outra linha.
  if (review.chosen_response_id === llmResponse.id) return false;

  const matches = verdictMatcher(review, field);
  if (matches(llmResponse.answers?.[review.field_name])) return false;
  return !pairedWithVerdict(review, llmResponse, matches, ctx);
}

function pairedWithVerdict(
  review: MetricsReview,
  llmResponse: MetricsResponse,
  matches: VerdictMatcher,
  ctx: MetricsContext,
): boolean {
  const groupKeys = ctx.groupKeysFor(review.document_id, review.field_name);
  const llmKey = groupKeys.get(llmResponse.id);
  if (llmKey === undefined) return false;
  // A própria resposta do LLM entra na varredura sem efeito: quem chega aqui já
  // sabe que ela não bate com o veredito.
  return (ctx.responsesByDoc.get(review.document_id) ?? []).some(
    (response) =>
      groupKeys.get(response.id) === llmKey &&
      matches(response.answers?.[review.field_name]),
  );
}

// A resposta escolhida só serve de forma crua do veredito enquanto ainda é o
// veredito; editada depois da arbitragem, pré-marcaria no seletor um valor que
// ninguém arbitrou.
function chosenValueOf(review: MetricsReview, field: PydanticField, ctx: MetricsContext): unknown {
  const chosen = chosenResponseOf(review, ctx)?.answers?.[review.field_name];
  return chosen !== undefined && verdictMatcher(review, field)(chosen) ? chosen : undefined;
}

// A decisão explícita do revisor vence a classificação automática: "Ambos
// corretos" tira o erro do LLM sem aprovar valor; as decisões que aprovam
// valor dizem de quem foi o erro.
function resolutionIsError(resolution: EffectiveErrorResolution, measured: boolean): boolean {
  if (resolution.status === "upheld") return false;
  return resolution.status === "approved" ? resolution.isLlmError : measured;
}

/* ── Fonte A: Comparação (`reviews`) ── */
// Uma review por célula, entre as que valem (`pickValidCellReviews`): a
// rodada não entra na regra, a versão da pergunta sim. Célula cujo veredito
// perdeu a validade sai do numerador e do denominador até ser rearbitrada.
function comparisonCandidates(
  reviews: MetricsReview[],
  ctx: MetricsContext,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const review of pickValidCellReviews(reviews, ctx.fieldMap).values()) {
    // Sem resposta escolhida o veredito é "ambiguo", "pular", resposta nova
    // digitada ou a grade de `multi`: nenhum deles entrava na métrica, e
    // continuam fora. A escolha por célula vem antes deste filtro, a mesma do
    // Gabarito: um "ambiguo" mais recente tira a célula da métrica em vez de
    // deixar valer um veredito que o Gabarito já não mostra.
    if (!review.chosen_response_id) continue;

    // Documento excluído (soft delete) sai da métrica inteira, não só do
    // título: medir o acerto do LLM sobre um documento que o coordenador tirou
    // do projeto é ruído em ambos os sentidos.
    if (!ctx.isActiveDocument(review.document_id)) continue;

    const llmResponse = ctx.llmLatestByDoc.get(review.document_id);
    if (!llmResponse) continue;

    const field = ctx.fieldMap.get(review.field_name);
    if (!isMeasurableField(field)) continue;

    candidates.push(buildComparisonCandidate(review, field, llmResponse, ctx));
  }

  return candidates;
}

function buildComparisonCandidate(
  review: MetricsReview,
  field: PydanticField,
  llmResponse: MetricsResponse,
  ctx: MetricsContext,
): Candidate {
  const isError = comparisonIsError(review, field, llmResponse, ctx);
  const shared: SharedEntryFields = {
    documentId: review.document_id,
    documentTitle: ctx.titleOf(review.document_id),
    fieldName: review.field_name,
    schemaVersion: formatSchemaVersion(llmResponse),
    reviewedAt: review.created_at,
  };

  return {
    documentId: review.document_id,
    fieldName: review.field_name,
    decidedAt: review.created_at,
    isError,
    error: isError
      ? {
          ...shared,
          fieldDescription: field.description || review.field_name,
          llmAnswer: formatAnswer(llmResponse.answers?.[review.field_name]),
          llmJustification:
            llmResponse.justifications?.[review.field_name] || null,
          chosenVerdict: review.verdict,
          chosenValue: chosenValueOf(review, field, ctx),
          reviewerComment: review.comment,
          resolvedAt: ctx.resolvedAtOf(review.document_id, review.field_name),
          llmResponseId: llmResponse.id,
          chosenResponseId: review.chosen_response_id,
          source: "comparacao",
          sourceId: review.id,
        }
      : null,
    entry: { ...shared, isError },
  };
}

// A view produz uma linha por campo do schema para TODO documento com resposta
// do LLM, e marca 'consenso' sempre que não há linha em `field_reviews` —
// inclusive em documentos que ninguém codificou. O gate espelha
// `computeBacklogRows` (`auto-review-backlog.ts`), que é quem MATERIALIZA as
// linhas, e precisa espelhá-lo nos DOIS eixos que ele usa:
//
//   • codificação humana COMPLETA (`isCodingComplete`), senão a ausência de
//     linha num documento pela metade viraria concordância;
//   • campo APLICÁVEL às duas responses (`isFieldApplicable`), como no
//     `applicable.length < 2` de `computeDivergentFieldNames`. Sem o lado do
//     LLM, um campo acrescentado ao schema depois da rodada — ausente do
//     `answer_field_hashes` dela — e um condicional visível só para o humano
//     entravam como acerto: acrescentar um campo obrigatório hoje daria um
//     acerto de graça em cada documento já codificado.
function hasComparableHumanCoding(
  docId: string,
  field: PydanticField,
  llmResponse: MetricsResponse,
  ctx: MetricsContext,
): boolean {
  if (
    !isFieldApplicable(
      field,
      llmResponse.answers,
      llmResponse.answer_field_hashes ?? undefined,
    )
  )
    return false;

  return (ctx.responsesByDoc.get(docId) ?? []).some(
    (response) =>
      response.respondent_type === "humano" &&
      response.is_latest &&
      isFieldApplicable(
        field,
        response.answers,
        response.answer_field_hashes ?? undefined,
      ) &&
      ctx.codingIsComplete(response),
  );
}

type SharedEntryFields = Omit<ReviewedEntry, "isError">;

// Os snapshots congelam os valores sobre os quais o veredito foi dado; a
// resposta atual pode já ter sido revisada desde então. `arbitratedLlm` é a
// response a que o veredito se refere (`row.llm_response_id`), que depois de uma
// nova rodada NÃO é mais a `is_latest`: parear o snapshot da rodada 1 com a
// justificativa e a versão de schema da rodada 2 mostraria ao coordenador um
// argumento que defende outra resposta, e arquivaria o erro sob a versão errada.
function buildAutoReviewError(
  row: MetricsFinalAnswer,
  field: PydanticField,
  arbitratedLlm: MetricsResponse,
  shared: SharedEntryFields,
  ctx: MetricsContext,
): LlmError {
  return {
    ...shared,
    fieldDescription: field.description || row.field_name,
    llmAnswer: formatAnswer(
      row.llm_answer_snapshot ?? arbitratedLlm.answers?.[row.field_name],
    ),
    llmJustification: arbitratedLlm.justifications?.[row.field_name] || null,
    chosenVerdict: formatAnswer(row.human_answer_snapshot),
    chosenValue: row.human_answer_snapshot,
    reviewerComment: row.arbitrator_comment,
    resolvedAt: ctx.resolvedAtOf(row.document_id, row.field_name),
    llmResponseId: arbitratedLlm.id,
    chosenResponseId: row.human_response_id,
    source: "auto_revisao",
    sourceId: row.field_review_id,
  };
}

interface MeasurableAutoReviewRow {
  field: PydanticField;
  /** A response sobre a qual o veredito se deu, que só coincide com a corrente
   *  enquanto não houve nova rodada. Em 'consenso' não há `llm_response_id`. */
  arbitratedLlm: MetricsResponse;
  isError: boolean;
}

// A cadeia de guardas da fonte B, separada da montagem do candidato. `null`
// quando a linha não é mensurável: documento excluído, campo fora da superfície
// de revisão, documento sem LLM corrente, codificação humana ausente ou
// incompleta, campo inaplicável a um dos lados, ou veredito ainda pendente.
function measurableAutoReviewRow(
  row: MetricsFinalAnswer,
  ctx: MetricsContext,
): MeasurableAutoReviewRow | null {
  // A view junta só `responses` e `projects` — nunca `documents` —, então
  // documentos com `excluded_at`/`exclusion_pending_at` continuam nela com as
  // responses que sobreviveram ao soft delete.
  if (!ctx.isActiveDocument(row.document_id)) return null;

  const field = ctx.fieldMap.get(row.field_name);
  if (!isMeasurableField(field)) return null;

  const llmResponse = ctx.llmLatestByDoc.get(row.document_id);
  if (!llmResponse) return null;
  if (!hasComparableHumanCoding(row.document_id, field, llmResponse, ctx))
    return null;

  const outcome = classifyAutoReview(row);
  if (outcome === "pendente") return null;

  return {
    field,
    arbitratedLlm:
      (row.llm_response_id
        ? ctx.responseById.get(row.llm_response_id)
        : undefined) ?? llmResponse,
    isError: outcome === "erro",
  };
}

/* ── Fonte B: Auto-revisão (view `final_answers`) ── */
function autoReviewCandidate(
  row: MetricsFinalAnswer,
  ctx: MetricsContext,
): Candidate | null {
  const measurable = measurableAutoReviewRow(row, ctx);
  if (!measurable) return null;
  const { field, arbitratedLlm, isError } = measurable;
  const decidedAt = row.final_decided_at ?? row.self_reviewed_at ?? null;
  const shared: SharedEntryFields = {
    documentId: row.document_id,
    documentTitle: ctx.titleOf(row.document_id),
    fieldName: row.field_name,
    schemaVersion: formatSchemaVersion(arbitratedLlm),
    // Consenso não tem instante de decisão; a data da resposta do LLM é o que
    // situa a entrada no tempo para o filtro de período.
    reviewedAt: decidedAt ?? arbitratedLlm.created_at,
  };

  return {
    documentId: row.document_id,
    fieldName: row.field_name,
    decidedAt,
    isError,
    error: isError
      ? buildAutoReviewError(row, field, arbitratedLlm, shared, ctx)
      : null,
    entry: { ...shared, isError },
  };
}

function autoReviewCandidates(
  finalAnswers: MetricsFinalAnswer[],
  ctx: MetricsContext,
): Candidate[] {
  return finalAnswers.flatMap((row) => {
    const candidate = autoReviewCandidate(row, ctx);
    return candidate ? [candidate] : [];
  });
}

// Único ponto que decide se a fonte de auto-revisão vale para um projeto.
// Sem esse gate, um projeto de Comparação (`compare_llm`) veria toda a sua
// grade documento × campo entrar como acerto: medido no Zolgensma, o
// denominador saltava de 898 para 2944 e a taxa despencava de 37% para 11% —
// puro ruído de linhas 'consenso' que nunca passaram por auto-revisão, porque
// `field_reviews` não é materializado nesse modo.
//
// Exportado porque a página também precisa da resposta ANTES de consultar o
// banco: a view `final_answers` é cara (uma chamada de
// `is_auto_review_reconciliation_pending`, SECURITY DEFINER, por linha
// documento × campo) e não faz sentido pagá-la para descartar o resultado.
export function usesAutoReviewSource(automationMode: string | null): boolean {
  return automationMode === "auto_review_llm";
}

// Caso que saiu da lista de divergências (o LLM corrente concorda, a review foi
// substituída) mas tem decisão gravada: volta à fila a partir do contexto
// salvo, para a decisão continuar visível e reabrível. Só enquanto ela vale:
// contexto corrente (não `stale`) e, se ela depende do veredito de origem
// ("Ambos corretos", "Em discussão"), veredito ainda válido. Decisão que grava
// valor próprio vale mesmo com a fonte inválida (`applicableErrorResolution`).
// As que perderam a validade vão para `lapsed`, que a fila conta à parte;
// documento excluído e campo fora da métrica saem sem contar, como antes.
type RevivedOutcome = { kind: "revived"; error: LlmError } | { kind: "lapsed"; lapsed: LapsedDecision } | { kind: "ignored" };

function reviveDecision(resolution: ErrorResolutionRow, ctx: MetricsContext): RevivedOutcome {
  const saved = resolution.context;
  const field = ctx.fieldMap.get(resolution.field_name);
  if (!saved || !isMeasurableField(field) || !ctx.isActiveDocument(resolution.document_id)) return { kind: "ignored" };
  if (applicableErrorResolution(resolution, ctx.validReviewIds).status === "stale") {
    return { kind: "lapsed", lapsed: {
      documentId: resolution.document_id, documentTitle: ctx.titleOf(resolution.document_id),
      fieldName: resolution.field_name, fieldDescription: field.description || resolution.field_name,
      decision: resolution.decision, resolvedAt: resolution.resolved_at,
    } };
  }
  return { kind: "revived", error: revivedCase(resolution, saved, field, ctx) };
}

function revivedCase(
  resolution: ErrorResolutionRow,
  saved: NonNullable<ErrorResolutionRow["context"]>,
  field: PydanticField,
  ctx: MetricsContext,
): LlmError {
  const autoReview = saved.source.kind === "auto_revisao";
  return {
    documentId: resolution.document_id, documentTitle: ctx.titleOf(resolution.document_id),
    fieldName: resolution.field_name, fieldDescription: field.description,
    llmAnswer: formatAnswer(saved.llm_value.value),
    // Na Comparação o veredito é o da review gravada na fonte; a resposta
    // humana do contexto é a de um codificador e não vira "veredito".
    chosenVerdict: autoReview ? formatAnswer(saved.human_value.value) : String(saved.source.verdict ?? ""),
    ...(autoReview ? { chosenValue: saved.human_value.value } : {}),
    llmJustification: null, reviewerComment: null, resolvedAt: resolution.resolved_at,
    reviewedAt: resolution.resolved_at, schemaVersion: null,
    llmResponseId: saved.llm_response_id, chosenResponseId: saved.human_response_id,
    source: autoReview ? "auto_revisao" : "comparacao",
    sourceId: typeof saved.source.id === "string" ? saved.source.id : null,
  };
}

export function computeLlmErrorMetrics(input: LlmErrorMetricsInput): {
  errors: LlmError[];
  reviewedEntries: ReviewedEntry[];
  /** Decisões que a fila deixou de mostrar por terem perdido a validade. */
  lapsedDecisions: LapsedDecision[];
} {
  const ctx = buildContext(input);

  const autoReviewEnabled = usesAutoReviewSource(input.automationMode);

  const candidates = [
    ...comparisonCandidates(input.reviews, ctx),
    ...(autoReviewEnabled ? autoReviewCandidates(input.finalAnswers, ctx) : []),
  ];

  /* ── Deduplicação por (documento, campo) ── */
  // Vale tanto ENTRE as fontes quanto DENTRO da Comparação: `reviews` é única
  // por (projeto, doc, campo, revisor), então um campo revisado por três
  // pessoas rendia três entradas e pesava o triplo na taxa. Uma entrada por
  // campo é a leitura certa de "quantos campos o LLM errou" — medido no
  // projeto Zolgensma, o efeito é de menos de 1 ponto percentual (961 reviews
  // colapsam em 898 campos), mas o peso deixa de depender de quantas pessoas
  // passaram pelo documento.
  const winners = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.documentId}:${candidate.fieldName}`;
    const incumbent = winners.get(key);
    if (!incumbent || beats(candidate, incumbent)) winners.set(key, candidate);
  }

  // Ordem estável por (documento, campo): a ordem de retorno do Postgres não é
  // garantida, e a UI exibe esta lista como está quando o sort é "default".
  const sorted = [...winners.values()].sort((a, b) =>
    a.documentId === b.documentId
      ? a.fieldName.localeCompare(b.fieldName)
      : a.documentId.localeCompare(b.documentId),
  );

  const cases = new Map<string, LlmError>(sorted.flatMap((c) => c.error ? [[`${c.documentId}:${c.fieldName}`, c.error] as const] : []));
  const lapsedDecisions: LapsedDecision[] = [];
  for (const [key, resolution] of input.errorResolutions) {
    if (cases.has(key)) continue;
    const outcome = reviveDecision(resolution, ctx);
    if (outcome.kind === "revived") cases.set(key, outcome.error);
    else if (outcome.kind === "lapsed") lapsedDecisions.push(outcome.lapsed);
  }
  return {
    lapsedDecisions,
    errors: [...cases.entries()].map(([key, error]) => ({
      ...error,
      resolution: input.errorResolutions.get(key),
    })),
    reviewedEntries: sorted.map((c) => {
      const resolution = applicableErrorResolution(input.errorResolutions.get(`${c.documentId}:${c.fieldName}`), ctx.validReviewIds);
      return {
        ...c.entry,
        isError: resolutionIsError(resolution, c.entry.isError),
        isPending: resolution.status === "discussion",
      };
    }),
  };
}
