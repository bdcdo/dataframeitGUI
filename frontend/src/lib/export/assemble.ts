// Montagem pura e testável dos datasets de export (feature 004), portada do RSC
// reviews/export/page.tsx. Sem I/O: recebe as linhas cruas do Supabase e devolve
// as visões Documentos/Respostas/Gabarito + o CSV unificado já como string[][].
//
// Decisões de design (ver data-model.md §3):
// - A BASE é a tabela documents (não as respostas): identidade e título de cada
//   documento vêm daí (document_id = external_id || id), de forma consistente em
//   TODAS as visões — assim o XLSX cruza abas pelo mesmo id. Respostas e reviews
//   de documentos fora da base (ex.: excluídos) são descartados (achado C1).
// - Colunas originais: união preservando a ordem do CSV, docs por created_at asc.
// - Colisão de nome de coluna original com controle/campo do schema → original_<nome>.

import type { AnswerFieldHashes, DocumentMetadata, PydanticField } from "@/lib/types";
import { groupBy } from "@/lib/utils";
import {
  multiSelectionSets,
  multiSelectionsAgree,
} from "@/lib/compare-multi-options";
import { answerGroupKeys, type EquivalencePair } from "@/lib/equivalence";
import {
  buildEquivalenceMap,
  isFieldApplicable,
  type EquivalenceRow,
} from "@/lib/compare-divergence";
import { isFieldVisible } from "@/lib/conditional";
import type { AutoReviewProvenance } from "@/lib/llm-error-metrics";
import { formatExportValue, formatVerdict } from "./format";
import { effectiveErrorResolution, errorResolutionComment, type EffectiveErrorResolution, type ErrorResolutionRow } from "@/lib/error-resolution";
import { pickValidCellReviews, reviewIsValid } from "@/lib/review-validity";
import { isSubmittedResponse } from "@/lib/compare-version";

export interface ExportSheet {
  headers: string[];
  rows: string[][];
}

export interface ExportDataset {
  projectName: string;
  documents: ExportSheet;
  responses: ExportSheet;
  verdicts: ExportSheet;
  /** Células do Gabarito em branco, com o motivo. Só vai para o XLSX. */
  pending: ExportSheet;
  /** Células do Gabarito preenchidas pela opção `fillFromLlm`. Só vai para o XLSX. */
  llmOnly: ExportSheet;
  csv: ExportSheet;
}

export interface ExportDocument {
  id: string;
  external_id: string | null;
  title: string | null;
  created_at: string;
  metadata: DocumentMetadata | null;
}

export interface ExportResponse {
  id: string;
  document_id: string;
  respondent_name: string | null;
  respondent_type: string;
  answers: Record<string, unknown> | null;
  /** Decide se um par "=" ainda vale para a versão atual da pergunta. */
  answer_field_hashes?: AnswerFieldHashes;
  /** Rascunho, pela régua da Comparação (`isSubmittedResponse`). */
  is_partial: boolean;
}

/** Linha da view `final_answers`: o valor e a proveniência da auto-revisão. */
export interface ExportFinalAnswer {
  document_id: string;
  field_name: string;
  provenance: AutoReviewProvenance;
  answer: unknown;
}

export interface ExportReview {
  id: string;
  document_id: string;
  field_name: string;
  verdict: string;
  comment: string | null;
  created_at: string;
  /** `reviews.field_hash`: o hash do campo quando a arbitragem foi feita. */
  field_hash: string | null;
  chosen_response_id: string | null;
}

export interface AssembleInput {
  projectName: string;
  fields: PydanticField[];
  minResponses: number;
  documents: ExportDocument[];
  responses: ExportResponse[];
  reviews: ExportReview[];
  errorResolutions?: ErrorResolutionRow[];
  /** Pares "=" vigentes (`superseded_at IS NULL`), COM as colunas de snapshot. */
  equivalences?: EquivalenceRow[];
  /** Vazio quando o projeto não usa auto-revisão. */
  finalAnswers?: ExportFinalAnswer[];
  /**
   * Preenche com a resposta do LLM a célula do Gabarito que nenhum
   * pesquisador respondeu, e põe os campos `llm_only` nas colunas. Desligado
   * por padrão porque o Gabarito serve para medir o LLM: uma célula com o valor
   * dele contaria como acerto dele mesmo. Ligado, o arquivo serve para usar o
   * dado, e as células que só o LLM preencheu ficam listadas na aba "Só LLM".
   */
  fillFromLlm?: boolean;
  /**
   * Conta os rascunhos no Gabarito e nas Pendências. Desligado por padrão
   * porque a Comparação não os considera (`isSubmittedResponse`): rascunho é
   * resposta que o pesquisador não entregou, e a célula que só ele preenchia
   * sai em branco, com o motivo que as demais respostas derem. O documento em
   * que todo pesquisador só tem rascunho conta como não codificado, como na
   * fila de codificação, e não entra nas Pendências. Independe de
   * `fillFromLlm`: sem o rascunho, a célula que ninguém mais respondeu é célula
   * sem pesquisador, e a opção do LLM a preenche. As abas Respostas e o CSV
   * mostram os rascunhos com a opção ligada ou não, marcados em `DRAFT_COLUMN`.
   */
  includeDrafts?: boolean;
}

// Colunas de controle do CSV unificado + reviewer_comments. Formam, junto dos
// nomes dos campos do schema, o conjunto "reservado" contra o qual as colunas
// originais podem colidir (data-model §3.5).
const CONTROL_COLUMNS = [
  "document_id",
  "document_title",
  "respondent",
  "respondent_type",
  "source",
] as const;
const REVIEWER_COMMENTS = "reviewer_comments";
// Marca de rascunho nas linhas de resposta (abas Respostas e CSV). Vai no fim
// das duas, depois de `reviewer_comments` no CSV, para que as colunas que já
// existiam fiquem na mesma posição: quem lê o arquivo por índice não quebra.
// O nome em português segue as abas mais novas (Pendências, Só LLM). Entra
// no conjunto reservado, como as colunas de controle.
const DRAFT_COLUMN = "rascunho";
const draftCell = (r: ExportResponse): string => (isSubmittedResponse(r) ? "não" : "sim");

// Resolve os cabeçalhos exibidos das colunas originais garantindo unicidade:
// colidiu com um nome reservado → prefixo `original_`; se o resultado ainda
// estiver tomado (ex.: já existe uma coluna literal `original_x`), acrescenta
// sufixo numérico `_2`, `_3`... O mapeamento é posicional com `rawCols`.
export function resolveOriginalHeaders(
  rawCols: string[],
  reserved: Set<string>
): string[] {
  const taken = new Set(reserved);
  return rawCols.map((col) => {
    let name = reserved.has(col) ? `original_${col}` : col;
    if (taken.has(name)) {
      let n = 2;
      while (taken.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    taken.add(name);
    return name;
  });
}

interface DocIdentity {
  displayId: string;
  title: string;
}

interface VerdictEntry {
  fields: Map<string, string>;
  comments: string[];
}

// Identidade e título de cada documento derivam da base (document_id =
// external_id || id), consistentes em todas as visões. O título é `title || ""`
// SEM fallback para external_id de propósito: o document_id já carrega o
// external_id, então o fallback só duplicaria o id numa segunda coluna.
function buildIdentity(baseDocs: ExportDocument[]): Map<string, DocIdentity> {
  return new Map(
    baseDocs.map((d) => [
      d.id,
      { displayId: d.external_id || d.id, title: d.title || "" },
    ])
  );
}

// União ordenada das colunas originais cruas (docs por created_at asc já
// ordenados; primeira aparição vence).
function unionOriginalColumns(baseDocs: ExportDocument[]): string[] {
  const union: string[] = [];
  const seen = new Set<string>();
  for (const d of baseDocs) {
    for (const col of d.metadata?.original_columns ?? []) {
      if (!seen.has(col)) {
        seen.add(col);
        union.push(col);
      }
    }
  }
  return union;
}

// Agrupa os veredictos do revisor por documento (valor formatado + comentários),
// pela regra única de `review-validity.ts`: o valor da célula é o da review de
// `pickValidCellReviews`, de qualquer rodada, e os comentários são os das
// reviews válidas da célula. Veredito que perdeu a validade (a pergunta mudou
// depois dele, ou o valor saiu das opções) não é gabarito, e o comentário dele
// sai junto, de propósito: foi escrito sobre outra versão da pergunta. Sai do
// arquivo inteiro, não só da célula: o texto do revisor só aparece na coluna
// `reviewer_comments`, alimentada também por estas entradas (as decisões de
// erro entram nela por `applyExportResolutions`), e o export não tem aba de
// comentários (ver o `return` de `assembleExport`). Quem precisar dele lê a
// tela de Comentários do app, que mostra todo comentário.
function buildVerdictsByDoc(
  reviews: ExportReview[],
  fieldByName: ReadonlyMap<string, PydanticField>,
): Map<string, VerdictEntry> {
  const byDoc = new Map<string, VerdictEntry>();
  const entryOf = (documentId: string) => {
    let entry = byDoc.get(documentId);
    if (!entry) {
      entry = { fields: new Map(), comments: [] };
      byDoc.set(documentId, entry);
    }
    return entry;
  };
  for (const r of pickValidCellReviews(reviews, fieldByName).values()) {
    entryOf(r.document_id).fields.set(r.field_name, formatVerdict(r.verdict));
  }
  for (const r of reviews) {
    if (!r.comment || !reviewIsValid(r, fieldByName.get(r.field_name))) continue;
    entryOf(r.document_id).comments.push(`[${r.field_name}] ${r.comment}`);
  }
  return byDoc;
}

// O que a decisão escreve na célula, ou `undefined` para deixá-la como está.
// "Ambos corretos" não aprova valor: o campo fica com o que o veredito ou a
// concordância já puseram ali, e só recebe o veredito guardado no contexto
// (auto-revisão) quando nada chegou por outra via.
function exportResolutionValue(
  resolution: ExportedResolution,
  cellHasValue: boolean,
): string | undefined {
  if (resolution.status === "approved") return formatExportValue(resolution.value);
  if (resolution.status === "discussion") return "";
  return cellHasValue || resolution.verdictValue === undefined ? undefined : formatExportValue(resolution.verdictValue);
}

type ExportedResolution = Extract<EffectiveErrorResolution, { status: "approved" | "discussion" | "upheld" }>;

function exportedResolution(row: ErrorResolutionRow): ExportedResolution | null {
  const resolution = effectiveErrorResolution(row);
  return resolution.status === "approved" || resolution.status === "discussion" || resolution.status === "upheld"
    ? resolution : null;
}

function applyExportResolutions(
  verdicts: Map<string, VerdictEntry>,
  rows: ErrorResolutionRow[],
  documents: ReadonlyMap<string, DocIdentity>,
  fieldNames: ReadonlySet<string>,
): void {
  for (const row of rows) {
    if (!documents.has(row.document_id) || !fieldNames.has(row.field_name)) continue;
    const resolution = exportedResolution(row);
    if (!resolution) continue;
    const existing = verdicts.get(row.document_id);
    const entry = existing ?? { fields: new Map<string, string>(), comments: [] };
    const value = exportResolutionValue(resolution, entry.fields.has(row.field_name));
    // Decisão que não escreve valor não cria linha de Gabarito sozinha: um
    // documento só com o comentário sairia no arquivo com todos os campos em
    // branco, e a tela do Gabarito não o mostra.
    if (value === undefined && !existing) continue;
    if (value !== undefined) entry.fields.set(row.field_name, value);
    entry.comments.push(errorResolutionComment(row));
    verdicts.set(row.document_id, entry);
  }
}

function cellKey(documentId: string, fieldName: string): string {
  return `${documentId}:${fieldName}`;
}

// Motivos da aba Pendências. Saem só do que o export já lê: nenhum deles
// justifica uma consulta a mais.
const PENDING_REASON = {
  discussion: "em discussão no LLM Insights",
  arbitration: "aguarda arbitragem",
  autoReview: "auto-revisão pendente",
  questionChanged: "pergunta alterada",
  ambiguous: "ambíguo ou pular",
  fewResponses: "poucas respostas",
  researchers: "divergência entre pesquisadores",
  uncompared: "respostas divergem e o campo não entra na Comparação",
  llmOnly: "só o LLM respondeu",
  nobody: "ninguém respondeu o campo",
  contradiction: (parent: string) => `julgamento contradiz o campo ${parent}`,
} as const;

// O que cada proveniência da view `final_answers` faz com a célula: "decidido"
// quando o CASE da view devolve em `answer` o snapshot que a auto-revisão
// escolheu; um motivo quando o ciclo está aberto ou não produz gabarito;
// `null` em 'consenso', que é a ausência de ciclo e que a view emite para todo
// campo, com ou sem codificação humana: ali quem decide é a concordância. O
// `satisfies` quebra a compilação se a view ganhar um estado sem destino aqui.
const AUTO_REVIEW_CELL = {
  auto_corrigido: "decidido",
  equivalente: "decidido",
  arbitrado: "decidido",
  consenso: null,
  aguarda_reconciliacao: PENDING_REASON.autoReview,
  aguarda_auto_revisao: PENDING_REASON.autoReview,
  aguarda_arbitragem: PENDING_REASON.arbitration,
  ambiguo: PENDING_REASON.ambiguous,
  pergunta_alterada: PENDING_REASON.questionChanged,
} satisfies Record<AutoReviewProvenance, string | null>;

// As respostas atuais de um documento, separadas como a concordância as usa.
interface DocResponses {
  all: ExportResponse[];
  humans: ExportResponse[];
  llm: ExportResponse | undefined;
}

// Se um conjunto de respostas cai num grupo só. `multi` segue a regra de
// `computeDivergentFieldNames`: conjuntos de opções, sem pares "=", que a
// Comparação não oferece nesse tipo. Os demais tipos usam as classes de
// `answerGroupKeys` (pares "=" vigentes mais a mesma resposta normalizada).
function groupAgreement(
  field: PydanticField,
  applicable: DocResponses,
  pairs: readonly EquivalencePair[],
): (responses: ExportResponse[]) => boolean {
  if (field.type === "multi" && field.options?.length) {
    const options = field.options;
    return (responses) =>
      multiSelectionsAgree(options, multiSelectionSets(responses.map((r) => r.answers?.[field.name])));
  }
  const keys = answerGroupKeys(applicable.all, pairs, field, field.name);
  return (responses) => new Set(responses.map((r) => keys.get(r.id))).size === 1;
}

// O valor de um grupo concordante. A resposta do LLM vem primeiro: é uma só
// por documento e sai do mesmo gerador em todos eles, então a coluna fica com
// a mesma grafia de documento para documento, enquanto entre pesquisadores o
// mesmo conteúdo aparece escrito de jeitos diferentes ("NI", "N/A"). Sem o LLM
// no grupo, vence a forma mais frequente, e o empate cai na ordem alfabética
// para que dois exports do mesmo dado saiam iguais: a ordem das linhas que o
// Postgres devolve não é estável.
function groupValue(fieldName: string, group: ExportResponse[], llm: ExportResponse | undefined): string {
  if (llm && group.includes(llm)) return formatExportValue(llm.answers?.[fieldName]);
  const counts = new Map<string, number>();
  for (const r of group) {
    const value = formatExportValue(r.answers?.[fieldName]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].sort(([a, na], [b, nb]) => nb - na || a.localeCompare(b, "pt-BR"))[0][0];
}

// As respostas que contam numa célula que a linha do Gabarito já deu como
// aplicável, por `isFieldApplicable`, o mesmo predicado da Comparação e da view
// `final_answers`: quem codificou antes de o campo existir, ou respondeu o
// campo pai com outro valor e por isso não viu este, não tem resposta a
// comparar, e o branco dele não conta como voto nem como divergência. Campo
// `llm_only` (que só chega aqui com `fillFromLlm`) não aparece na codificação
// humana, e o pesquisador nunca o responde: a resposta legada, sem
// `answer_field_hashes`, passaria por `isFieldApplicable` e o branco dela
// divergiria do LLM.
function applicableResponses(field: PydanticField, doc: DocResponses): DocResponses {
  return splitResponses(
    doc.all.filter((r) =>
      (field.target !== "llm_only" || r.respondent_type === "llm") &&
      isFieldApplicable(field, r.answers, r.answer_field_hashes ?? undefined)),
  );
}

// Consenso da célula, ou null, contado só entre as respostas que contam, com
// pelo menos um pesquisador entre elas (a célula sem pesquisador é barrada
// antes). Vale quando todas elas, LLM incluído, caem num grupo (com o piso
// `minResponses` de sempre, sobre as respostas do documento), ou quando pelo
// menos dois pesquisadores caem num grupo e o LLM diverge: dois humanos
// concordantes já são gabarito, e o LLM é justamente o que está sendo medido.
// Um pesquisador só, sem o LLM, preenche com a resposta dele: ninguém mais viu
// o campo, e a Comparação também não a arbitraria (`applicable.length < 2` em
// `computeDivergentFieldNames`).
function cellConsensus(
  field: PydanticField,
  applicable: DocResponses,
  agree: (responses: ExportResponse[]) => boolean,
  totalResponses: number,
  minResponses: number,
): string | null {
  const floor = totalResponses >= minResponses;
  const allAgree = agree(applicable.all);
  if (allAgree && floor) return groupValue(field.name, applicable.all, applicable.llm);
  if (applicable.humans.length >= 2 && agree(applicable.humans)) {
    return groupValue(field.name, allAgree ? applicable.all : applicable.humans, applicable.llm);
  }
  return null;
}

interface CellContext {
  minResponses: number;
  autoReview: ReadonlyMap<string, ExportFinalAnswer>;
  /** Células com alguma review, válida ou não. */
  reviewedCells: ReadonlySet<string>;
  /** Células que a decisão "Em discussão" do LLM Insights deixou em branco. */
  discussed: ReadonlySet<string>;
  pairsByDoc: ReturnType<typeof buildEquivalenceMap>;
  fillFromLlm: boolean;
}

// A linha do Gabarito em montagem, na forma das respostas, para que as
// condições dos campos se avaliem com o mesmo `isFieldVisible` da codificação.
// Só tem chave o campo já decidido: com valor, ou `undefined` quando a condição
// dele não se cumpre. Campo sem chave está pendente, e o filho dele espera.
type GabaritoRow = Record<string, unknown>;

// A linha e os campos dela que só estão decididos porque `fillFromLlm` está
// ligada: os que o LLM preencheu, o branco que a condição tirou de um pai
// desses, e todo campo `llm_only`, que sem a opção nem entra no arquivo. Ligar
// a opção só pode mudar a célula que nenhum pesquisador respondeu; para as
// demais, esses campos contam como não decididos, como com a opção desligada.
interface GabaritoLine {
  row: GabaritoRow;
  optionOnly: Set<string>;
}

// Os rótulos de "ambíguo" e "pular" são o veredito de que o campo não tem
// valor, não um valor: a célula fica fora da linha, e o filho espera como se o
// pai estivesse pendente.
const NOT_A_VALUE = new Set([formatVerdict("ambiguo"), formatVerdict("pular")]);

// Grava na linha uma célula decidida. O multi volta a ser lista, desfazendo o
// "; " de `formatExportValue` e `formatVerdict`, porque a condição sobre ele
// testa pertinência.
function settleCell(row: GabaritoRow, field: PydanticField, cell: string | undefined): void {
  if (cell !== undefined && NOT_A_VALUE.has(cell)) return;
  row[field.name] = cell && field.type === "multi" ? cell.split("; ") : cell;
}

// A condição do campo avaliada na linha do Gabarito, e não na resposta de cada
// respondente: se um pesquisador só respondeu "Sim" ao pai e o Gabarito ficou
// com "Não", o filho que só ele viu não entra, senão a linha se contradiz.
// Devolve null quando o campo se aplica. O schema só aceita condição sobre
// campo anterior (`conditionTrigger` em pydantic-field.ts), então, percorrendo
// os campos na ordem dele, o pai já passou por aqui; pai fora do Gabarito
// (`none`, e `llm_only` sem `fillFromLlm`) nunca se decide, e o filho espera.
// `readOptionOnly` diz se o pai em `GabaritoLine.optionOnly` vale como
// decidido: só vale para a célula que nenhum pesquisador respondeu, e o branco
// que ele decide entra também nesse conjunto.
function conditionOutcome(field: PydanticField, line: GabaritoLine, readOptionOnly: boolean): CellOutcome | null {
  const parent = field.condition?.field;
  if (!parent) return null;
  const byOption = line.optionOnly.has(parent);
  if (!Object.hasOwn(line.row, parent) || (byOption && !readOptionOnly)) return { reason: `aguarda o campo ${parent}` };
  if (isFieldVisible(field, line.row)) return null;
  return byOption ? { value: undefined, optionOnly: true } : { value: undefined };
}

// `value: undefined` é o branco legítimo: a condição não se cumpre na linha.
// `notApplicable` marca o motivo que, mesmo deixando a célula nas Pendências,
// dá o campo como fora da linha (ver `judgedCell`).
// `optionOnly` marca a célula que só a opção `fillFromLlm` decidiu (ver
// `GabaritoLine`); com valor, é a que o LLM preencheu e vai para "Só LLM".
type CellOutcome = { value: string | undefined; optionOnly?: true } | { reason: string; notApplicable?: true };

// Uma célula com julgamento explícito (veredito do revisor, decisão do LLM
// Insights, auto-revisão decidida) diante da condição do campo na linha. O
// julgamento não passa por cima da condição: se o pai no Gabarito diz que o
// campo não se aplica e o julgamento pôs valor nele, os dois se contradizem, e
// a célula fica em branco nas Pendências até alguém decidir qual dos dois
// cede. Branco não contradiz nada: é o que a condição pede, e é o que "Erro
// humano" aprova quando o LLM deixou de fora o campo condicional. "Ambíguo" e
// "pular" (`NOT_A_VALUE`) também não, porque não afirmam valor nenhum: entram
// como antes da regra, e o filho deles espera. Pai ainda pendente, ou decidido
// só pela opção `fillFromLlm`, também não: o julgamento entra, porque não há o
// que contradizer.
// Na contradição, o campo sai da linha como não aplicável (`settleCell` com
// `undefined`), o mesmo estado do branco legítimo: é o que o pai no Gabarito
// diz, e assim o neto segue a linha como ela está, em vez de esperar por um
// filho que, com esse pai, nunca terá valor.
function judgedCell(field: PydanticField, line: GabaritoLine, cell: string): CellOutcome {
  const parent = field.condition?.field;
  const gate = conditionOutcome(field, line, false);
  if (parent && gate && "value" in gate && cell !== "" && !NOT_A_VALUE.has(cell)) {
    return { reason: PENDING_REASON.contradiction(parent), notApplicable: true };
  }
  return { value: cell };
}

// Uma célula sem veredito: o valor que ela recebe ou o motivo de ficar em
// branco. Ordem: auto-revisão decidida (pesada contra a condição por
// `judgedCell`), condição na linha do Gabarito, concordância, e então o motivo.
function resolveCell(
  docId: string,
  field: PydanticField,
  doc: DocResponses,
  line: GabaritoLine,
  ctx: CellContext,
): CellOutcome {
  const auto = ctx.autoReview.get(cellKey(docId, field.name));
  if (auto && AUTO_REVIEW_CELL[auto.provenance] === "decidido") return judgedCell(field, line, formatExportValue(auto.answer));
  const applicable = applicableResponses(field, doc);
  const uncoded = applicable.humans.length === 0;
  const gate = conditionOutcome(field, line, uncoded);
  if (gate) return gate;
  // Vem depois da condição na linha: o LLM não preenche campo que ela diz não
  // se aplicar.
  if (uncoded) return uncodedCell(field, applicable, ctx.fillFromLlm);
  const pairs = ctx.pairsByDoc.get(docId)?.get(field.name) ?? [];
  const agree = groupAgreement(field, applicable, pairs);
  const consensus = cellConsensus(field, applicable, agree, doc.all.length, ctx.minResponses);
  if (consensus !== null) return { value: consensus };
  const signals = pendingSignals(field, doc, applicable, agree, ctx.minResponses);
  return { reason: pendingReason(cellKey(docId, field.name), ctx, signals) };
}

// Célula sem pesquisador entre as respostas que contam: não há gabarito. Só o
// LLM: fica pendente, salvo com `AssembleInput.fillFromLlm` (a resposta em
// branco não tem o que preencher e segue pendente). Ninguém: a linha diz que o
// campo se aplica, mas nenhum respondente o viu nessa condição (o pai no
// Gabarito veio de um veredito que ninguém tinha escolhido, ou o campo nasceu
// depois da codificação), e o branco precisa de quem o preencha.
function uncodedCell(field: PydanticField, applicable: DocResponses, fillFromLlm: boolean): CellOutcome {
  const llmCell = fillFromLlm && applicable.llm ? formatExportValue(applicable.llm.answers?.[field.name]) : "";
  if (llmCell !== "") return { value: llmCell, optionOnly: true };
  return { reason: applicable.all.length > 0 ? PENDING_REASON.llmOnly : PENDING_REASON.nobody };
}

// O que decide o motivo de uma célula que ficou sem consenso.
interface PendingSignals {
  researchersDiverge: boolean;
  /** O campo entra na Comparação, que não examina `human_only`. */
  inComparison: boolean;
  fewResponses: boolean;
}

function pendingSignals(
  field: PydanticField,
  doc: DocResponses,
  applicable: DocResponses,
  agree: (responses: ExportResponse[]) => boolean,
  minResponses: number,
): PendingSignals {
  const allAgree = agree(applicable.all);
  return {
    researchersDiverge: applicable.humans.length >= 2 && !agree(applicable.humans),
    // A regra de `computeDivergentFieldNames` pede também duas ou mais
    // respostas que contam e divergem; os dois usos em `pendingReason` já
    // garantem isso (pesquisadores divergentes, ou `fewResponses` falso).
    inComparison: field.target !== "human_only",
    // As que contam concordam e mesmo assim não fizeram consenso, então só o
    // piso `minResponses` as barrou; ou o documento todo fica abaixo do piso
    // sem dois pesquisadores.
    fewResponses: allAgree || (doc.all.length < minResponses && doc.humans.length < 2),
  };
}

function pendingReason(key: string, ctx: CellContext, signals: PendingSignals): string {
  // Pesquisadores que divergem entre si vêm antes da auto-revisão: o ciclo de
  // auto-revisão confronta o LLM com um pesquisador só (`field_reviews` tem uma
  // linha por documento e campo), e a divergência com os demais é resolvida na
  // Comparação, também nos projetos de auto-revisão.
  if (signals.researchersDiverge && signals.inComparison) return PENDING_REASON.researchers;
  const auto = ctx.autoReview.get(key);
  const autoReason = auto ? AUTO_REVIEW_CELL[auto.provenance] : null;
  if (autoReason) return autoReason;
  // Há review na célula e nenhuma entrou no Gabarito: todas perderam a
  // validade (`review-validity.ts`), porque a pergunta mudou depois delas.
  if (ctx.reviewedCells.has(key)) return PENDING_REASON.questionChanged;
  if (signals.fewResponses) return PENDING_REASON.fewResponses;
  // Sem ler as atribuições não se sabe se a comparação já foi aberta; o que se
  // sabe é se a regra da Comparação vê a divergência. Quando não vê (campo
  // `human_only`), ninguém vai arbitrar.
  return signals.inComparison ? PENDING_REASON.arbitration : PENDING_REASON.uncompared;
}

// O contexto das células sem veredito, montado do que o export leu.
function buildCellContext(input: AssembleInput, baseReviews: ExportReview[], fillFromLlm: boolean): CellContext {
  const discussed = (input.errorResolutions ?? []).filter((row) => exportedResolution(row)?.status === "discussion");
  return {
    minResponses: input.minResponses,
    autoReview: new Map((input.finalAnswers ?? []).map((row) => [cellKey(row.document_id, row.field_name), row])),
    reviewedCells: new Set(baseReviews.map((r) => cellKey(r.document_id, r.field_name))),
    discussed: new Set(discussed.map((row) => cellKey(row.document_id, row.field_name))),
    pairsByDoc: buildEquivalenceMap(input.equivalences ?? []),
    fillFromLlm,
  };
}

// As células de um documento, na ordem do schema: as que o veredito, a
// auto-revisão ou a concordância preenchem, e as que ficam em branco, com o
// motivo. O veredito (com as decisões do LLM Insights, que chegam pelo mesmo
// mapa em `applyExportResolutions`) vale acima da concordância, mas não acima
// da condição: passa por `judgedCell` como a auto-revisão decidida. O branco
// de "Em discussão" vai para as Pendências antes disso.
function resolveDocCells(
  docId: string,
  doc: DocResponses,
  verdictFields: ReadonlyMap<string, string> | undefined,
  fields: PydanticField[],
  ctx: CellContext,
): DocCells {
  const cells: DocCells = { filled: new Map(), pending: [], fromLlm: [] };
  const line: GabaritoLine = { row: {}, optionOnly: new Set() };
  for (const field of fields) {
    if (field.target === "llm_only") line.optionOnly.add(field.name);
    const verdict = verdictFields?.get(field.name);
    if (verdict !== undefined && ctx.discussed.has(cellKey(docId, field.name))) {
      cells.pending.push([field.name, PENDING_REASON.discussion]);
      continue;
    }
    const outcome = verdict !== undefined ? judgedCell(field, line, verdict) : resolveCell(docId, field, doc, line, ctx);
    recordCell(cells, line, field, outcome);
  }
  return cells;
}

interface DocCells {
  filled: Map<string, string>;
  pending: [string, string][];
  /** As células que o LLM preencheu, para a aba "Só LLM". */
  fromLlm: string[];
}

// Grava o desfecho de uma célula nas saídas do documento e na linha, onde os
// campos seguintes leem a condição.
function recordCell(cells: DocCells, line: GabaritoLine, field: PydanticField, outcome: CellOutcome): void {
  if ("reason" in outcome) {
    cells.pending.push([field.name, outcome.reason]);
    if (outcome.notApplicable) settleCell(line.row, field, undefined);
    return;
  }
  if (outcome.value !== undefined) cells.filled.set(field.name, outcome.value);
  if (outcome.optionOnly) {
    line.optionOnly.add(field.name);
    if (outcome.value !== undefined) cells.fromLlm.push(field.name);
  }
  settleCell(line.row, field, outcome.value);
}

function splitResponses(all: ExportResponse[] = []): DocResponses {
  return {
    all,
    humans: all.filter((r) => r.respondent_type !== "llm"),
    llm: all.find((r) => r.respondent_type === "llm"),
  };
}

// Percorre os documentos: as células preenchidas vão para `filledByDoc`, as em
// branco viram linhas de Pendências, e as que só o LLM preencheu, de "Só LLM".
function resolveOpenCells(input: {
  baseDocs: ExportDocument[];
  identity: ReadonlyMap<string, DocIdentity>;
  exportableFields: PydanticField[];
  verdictsByDoc: ReadonlyMap<string, VerdictEntry>;
  responses: ExportResponse[];
  ctx: CellContext;
}): { filledByDoc: Map<string, Map<string, string>>; pendingRows: string[][]; llmOnlyRows: string[][] } {
  const responsesByDoc = groupBy(input.responses, (r) => r.document_id);
  const filledByDoc = new Map<string, Map<string, string>>();
  const pendingRows: string[][] = [];
  const llmOnlyRows: string[][] = [];
  for (const { id: docId } of input.baseDocs) {
    const doc = splitResponses(responsesByDoc.get(docId));
    const verdictFields = input.verdictsByDoc.get(docId)?.fields;
    const { filled, pending, fromLlm } = resolveDocCells(docId, doc, verdictFields, input.exportableFields, input.ctx);
    if (filled.size > 0) filledByDoc.set(docId, filled);
    // Entram nas Pendências os documentos que têm linha no Gabarito ou alguma
    // codificação humana. Documento só com a resposta do LLM (e, com
    // `includeDrafts` desligada, os rascunhos) ainda não foi codificado, e
    // listá-lo campo a campo só esconderia os brancos que importam.
    // Com `fillFromLlm`, o LLM preenche o documento e ele passa a ter linha.
    const hasGabaritoRow = filled.size > 0 || verdictFields !== undefined;
    if (!hasGabaritoRow && doc.humans.length === 0) continue;
    const { displayId, title } = input.identity.get(docId)!;
    for (const [fieldName, reason] of pending) pendingRows.push([displayId, title, fieldName, reason]);
    for (const fieldName of fromLlm) llmOnlyRows.push([displayId, title, fieldName]);
  }
  return { filledByDoc, pendingRows, llmOnlyRows };
}

// As respostas que contam no Gabarito e nas Pendências: sem `includeDrafts`,
// só as entregues, pela regra da Comparação.
function countedResponses(responses: ExportResponse[], includeDrafts: boolean): ExportResponse[] {
  return includeDrafts ? responses : responses.filter(isSubmittedResponse);
}

export function assembleExport(input: AssembleInput): ExportDataset {
  const { projectName, fields, documents, responses, reviews } = input;
  const fillFromLlm = input.fillFromLlm === true;
  const includeDrafts = input.includeDrafts === true;

  // `llm_only` só entra com `fillFromLlm`: sem ela, nenhuma célula dele teria
  // gabarito, porque nenhum pesquisador o responde.
  const exportableFields = fields.filter(
    (f) => f.target !== "none" && (fillFromLlm || f.target !== "llm_only")
  );
  const fieldNames = exportableFields.map((f) => f.name);
  const fieldNameSet = new Set(fieldNames);

  // Base ordenada de forma determinística (created_at asc, id como desempate).
  const baseDocs = [...documents].sort((a, b) => {
    if (a.created_at !== b.created_at)
      return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const docById = new Map(baseDocs.map((d) => [d.id, d]));
  const identity = buildIdentity(baseDocs);

  const unionRaw = unionOriginalColumns(baseDocs);

  // O inteiro teor sai APENAS na aba Documentos (coluna dedicada `document_text`,
  // uma linha por doc); as colunas auxiliares (tribunal, classe...) são leves e
  // seguem repetidas por linha no CSV. `text_column` tem escopo por documento:
  // um nome entra no header auxiliar se ao menos um documento o usa como coluna
  // auxiliar, mesmo que outro documento use o mesmo nome como inteiro teor.
  const auxiliaryColumns = new Set<string>();
  let hasText = false;
  for (const d of baseDocs) {
    const metadata = d.metadata;
    if (metadata?.text_column) hasText = true;
    for (const col of metadata?.original_columns ?? []) {
      if (col !== metadata?.text_column) auxiliaryColumns.add(col);
    }
  }
  const auxRaw = unionRaw.filter((col) => auxiliaryColumns.has(col));

  const reserved = new Set<string>([
    ...CONTROL_COLUMNS,
    REVIEWER_COMMENTS,
    DRAFT_COLUMN,
    ...fieldNames,
  ]);
  // Reserva `document_text` só quando há coluna de texto: assim uma coluna
  // auxiliar homônima vira `original_document_text` e o header dedicado do texto
  // fica garantidamente único. Sem texto, nenhuma coluna dedicada é criada e uma
  // auxiliar chamada `document_text` mantém seu nome.
  const auxReserved = hasText ? new Set([...reserved, "document_text"]) : reserved;
  const auxHeaders = resolveOriginalHeaders(auxRaw, auxReserved);
  const auxCells = (docId: string): string[] => {
    const metadata = docById.get(docId)?.metadata;
    return auxRaw.map((col) =>
      col === metadata?.text_column ? "" : (metadata?.original_row[col] ?? "")
    );
  };
  // Texto do documento (uma vez por doc, só na aba Documentos).
  const documentText = (docId: string): string => {
    const meta = docById.get(docId)?.metadata;
    return meta?.text_column ? (meta.original_row?.[meta.text_column] ?? "") : "";
  };

  // Filtragem à base (achado C1): descarta respostas/reviews de docs fora dela.
  const baseResponses = responses.filter((r) => identity.has(r.document_id));
  const baseReviews = reviews.filter((r) => identity.has(r.document_id));
  // As abas de respostas seguem com `baseResponses`, rascunhos incluídos.
  const codingResponses = countedResponses(baseResponses, includeDrafts);

  const fieldByName = new Map<string, PydanticField>();
  for (const f of fields) if (!fieldByName.has(f.name)) fieldByName.set(f.name, f);
  const verdictsByDoc = buildVerdictsByDoc(baseReviews, fieldByName);
  applyExportResolutions(verdictsByDoc, input.errorResolutions ?? [], identity, fieldNameSet);
  const { filledByDoc, pendingRows, llmOnlyRows } = resolveOpenCells({
    baseDocs,
    identity,
    exportableFields,
    verdictsByDoc,
    responses: codingResponses,
    ctx: buildCellContext(input, baseReviews, fillFromLlm),
  });

  // Documentos com gabarito (veredicto, auto-revisão ou concordância), na ordem da base.
  const gabaritoIds = baseDocs
    .map((d) => d.id)
    .filter((id) => verdictsByDoc.has(id) || filledByDoc.has(id));
  const gabaritoSet = new Set(gabaritoIds);

  // Cada célula vem de `resolveDocCells`, que aplica a prioridade: veredicto
  // do revisor (com as decisões do LLM Insights) > auto-revisão decidida >
  // concordância > vazio, com a condição na linha acima dos julgamentos.
  const verdictFieldValue = (docId: string, fieldName: string): string =>
    filledByDoc.get(docId)?.get(fieldName) ?? "";

  const sourceOf = (respondentType: string): string =>
    respondentType === "llm" ? "llm" : "codificacao";
  const responseFieldCells = (r: ExportResponse): string[] =>
    exportableFields.map((f) => formatExportValue(r.answers?.[f.name]));
  const verdictFieldCells = (docId: string): string[] =>
    fieldNames.map((name) => verdictFieldValue(docId, name));

  // --- Visão Documentos --- (única visão com o inteiro teor: coluna document_text)
  const documentsSheet: ExportSheet = {
    headers: [
      "document_id",
      "document_title",
      ...auxHeaders,
      ...(hasText ? ["document_text"] : []),
    ],
    rows: baseDocs.map((d) => {
      const info = identity.get(d.id)!;
      return [
        info.displayId,
        info.title,
        ...auxCells(d.id),
        ...(hasText ? [documentText(d.id)] : []),
      ];
    }),
  };

  // --- Visão Respostas individuais ---
  const responsesSheet: ExportSheet = {
    headers: [
      "document_id",
      "document_title",
      "respondent",
      "respondent_type",
      "source",
      ...fieldNames,
      DRAFT_COLUMN,
    ],
    rows: baseResponses.map((r) => {
      const info = identity.get(r.document_id)!;
      return [
        info.displayId,
        info.title,
        r.respondent_name || "",
        r.respondent_type,
        sourceOf(r.respondent_type),
        ...responseFieldCells(r),
        draftCell(r),
      ];
    }),
  };

  // --- Visão Gabarito ---
  const verdictsSheet: ExportSheet = {
    headers: [
      "document_id",
      "document_title",
      "source",
      ...fieldNames,
      REVIEWER_COMMENTS,
    ],
    rows: gabaritoIds.map((docId) => {
      const info = identity.get(docId)!;
      return [
        info.displayId,
        info.title,
        "comparacao",
        ...verdictFieldCells(docId),
        (verdictsByDoc.get(docId)?.comments ?? []).join(" | "),
      ];
    }),
  };

  // --- Visão Pendências --- (só no XLSX: o CSV é uma tabela só)
  const pendingSheet: ExportSheet = {
    headers: ["document_id", "document_title", "campo", "motivo"],
    rows: pendingRows,
  };

  // --- Visão Só LLM --- (só no XLSX, como Pendências)
  const llmOnlySheet: ExportSheet = {
    headers: ["document_id", "document_title", "campo"],
    rows: llmOnlyRows,
  };

  // --- CSV unificado: respostas + gabaritos + documentos órfãos ---
  const docsWithResponse = new Set(baseResponses.map((r) => r.document_id));
  const responseCsvRows = baseResponses.map((r) => {
    const info = identity.get(r.document_id)!;
    return [
      info.displayId,
      info.title,
      r.respondent_name || "",
      r.respondent_type,
      sourceOf(r.respondent_type),
      ...auxCells(r.document_id),
      ...responseFieldCells(r),
      "",
      draftCell(r),
    ];
  });
  const verdictCsvRows = gabaritoIds.map((docId) => {
    const info = identity.get(docId)!;
    return [
      info.displayId,
      info.title,
      "",
      "",
      "comparacao",
      ...auxCells(docId),
      ...verdictFieldCells(docId),
      (verdictsByDoc.get(docId)?.comments ?? []).join(" | "),
      "",
    ];
  });
  // Linha source=documento apenas para documentos SEM resposta E SEM gabarito.
  const documentoCsvRows = baseDocs
    .filter((d) => !docsWithResponse.has(d.id) && !gabaritoSet.has(d.id))
    .map((d) => {
      const info = identity.get(d.id)!;
      return [
        info.displayId,
        info.title,
        "",
        "",
        "documento",
        ...auxCells(d.id),
        ...fieldNames.map(() => ""),
        "",
        "",
      ];
    });

  const csvSheet: ExportSheet = {
    headers: [
      ...CONTROL_COLUMNS,
      ...auxHeaders,
      ...fieldNames,
      REVIEWER_COMMENTS,
      DRAFT_COLUMN,
    ],
    rows: [...responseCsvRows, ...verdictCsvRows, ...documentoCsvRows],
  };

  return {
    projectName,
    documents: documentsSheet,
    responses: responsesSheet,
    verdicts: verdictsSheet,
    pending: pendingSheet,
    llmOnly: llmOnlySheet,
    csv: csvSheet,
  };
}
