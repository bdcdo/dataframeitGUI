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
  computeDivergentFieldNames,
  isFieldApplicable,
  type EquivalenceRow,
} from "@/lib/compare-divergence";
import type { AutoReviewProvenance } from "@/lib/llm-error-metrics";
import { formatExportValue, formatVerdict } from "./format";
import { effectiveErrorResolution, errorResolutionComment, type EffectiveErrorResolution, type ErrorResolutionRow } from "@/lib/error-resolution";
import { pickValidCellReviews, reviewIsValid } from "@/lib/review-validity";

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
  uncompared: "divergência sem comparação",
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

// As respostas em que o campo se aplica, por `isFieldApplicable`, o mesmo
// predicado da Comparação e da view `final_answers`: campo condicional oculto
// para o respondente, ou que ainda não existia quando ele codificou, não tem
// resposta a comparar, e o branco dele não conta como voto.
function applicableResponses(field: PydanticField, doc: DocResponses): DocResponses {
  return splitResponses(
    doc.all.filter((r) => isFieldApplicable(field, r.answers, r.answer_field_hashes ?? undefined)),
  );
}

// Consenso da célula, ou null, contado só entre as respostas em que o campo se
// aplica. Vale quando todas elas, LLM incluído, caem num grupo (com o piso
// `minResponses` de sempre, sobre as respostas do documento), ou quando pelo
// menos dois pesquisadores caem num grupo e o LLM diverge: dois humanos
// concordantes já são gabarito, e o LLM é justamente o que está sendo medido.
// Com uma resposta aplicável só, a Comparação não vê divergência
// (`applicable.length < 2` em `computeDivergentFieldNames`), e a célula recebe
// essa resposta; com nenhuma, o campo não se aplica a ninguém e fica vazio sem
// pendência.
function cellConsensus(
  field: PydanticField,
  applicable: DocResponses,
  agree: (responses: ExportResponse[]) => boolean,
  totalResponses: number,
  minResponses: number,
): string | null {
  const floor = totalResponses >= minResponses;
  if (applicable.all.length === 0) return floor ? "" : null;
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
  /** Campos que a Comparação lista como divergência a resolver, por documento. */
  comparisonDivergence: (docId: string, doc: DocResponses) => ReadonlySet<string>;
}

// Uma célula sem veredito: o valor que ela recebe ou o motivo de ficar em
// branco. Ordem: auto-revisão decidida, concordância, e então o motivo.
function resolveCell(
  docId: string,
  field: PydanticField,
  doc: DocResponses,
  ctx: CellContext,
): { value: string } | { reason: string } {
  const auto = ctx.autoReview.get(cellKey(docId, field.name));
  if (auto && AUTO_REVIEW_CELL[auto.provenance] === "decidido") return { value: formatExportValue(auto.answer) };
  const pairs = ctx.pairsByDoc.get(docId)?.get(field.name) ?? [];
  const applicable = applicableResponses(field, doc);
  const agree = groupAgreement(field, applicable, pairs);
  const consensus = cellConsensus(field, applicable, agree, doc.all.length, ctx.minResponses);
  if (consensus !== null) return { value: consensus };
  return { reason: pendingReason(docId, field.name, doc, ctx) };
}

function pendingReason(docId: string, fieldName: string, doc: DocResponses, ctx: CellContext): string {
  const key = cellKey(docId, fieldName);
  const auto = ctx.autoReview.get(key);
  const autoReason = auto ? AUTO_REVIEW_CELL[auto.provenance] : null;
  if (autoReason) return autoReason;
  // Há review na célula e nenhuma entrou no Gabarito: todas perderam a
  // validade (`review-validity.ts`), porque a pergunta mudou depois delas.
  if (ctx.reviewedCells.has(key)) return PENDING_REASON.questionChanged;
  if (doc.all.length < ctx.minResponses && doc.humans.length < 2) return PENDING_REASON.fewResponses;
  // Sem ler as atribuições não se sabe se a comparação já foi aberta; o que se
  // sabe é se a regra da Comparação vê a divergência. Quando não vê (campo
  // `human_only`), ninguém vai arbitrar.
  return ctx.comparisonDivergence(docId, doc).has(fieldName)
    ? PENDING_REASON.arbitration
    : PENDING_REASON.uncompared;
}

// A divergência pela regra da Comparação, calculada uma vez por documento e só
// quando uma célula dele fica em branco.
function memoizedComparisonDivergence(
  fields: PydanticField[],
  pairsByDoc: CellContext["pairsByDoc"],
): CellContext["comparisonDivergence"] {
  const cache = new Map<string, Set<string>>();
  return (docId, doc) => {
    let divergent = cache.get(docId);
    if (!divergent) {
      divergent = new Set(
        computeDivergentFieldNames(
          fields,
          doc.all.map((r) => ({ id: r.id, answers: r.answers, answerFieldHashes: r.answer_field_hashes ?? undefined })),
          pairsByDoc.get(docId),
        ),
      );
      cache.set(docId, divergent);
    }
    return divergent;
  };
}

// O contexto das células sem veredito, montado do que o export leu.
function buildCellContext(input: AssembleInput, baseReviews: ExportReview[]): CellContext {
  const pairsByDoc = buildEquivalenceMap(input.equivalences ?? []);
  const discussed = (input.errorResolutions ?? []).filter((row) => exportedResolution(row)?.status === "discussion");
  return {
    minResponses: input.minResponses,
    autoReview: new Map((input.finalAnswers ?? []).map((row) => [cellKey(row.document_id, row.field_name), row])),
    reviewedCells: new Set(baseReviews.map((r) => cellKey(r.document_id, r.field_name))),
    discussed: new Set(discussed.map((row) => cellKey(row.document_id, row.field_name))),
    pairsByDoc,
    comparisonDivergence: memoizedComparisonDivergence(input.fields, pairsByDoc),
  };
}

// As células de um documento: as que a auto-revisão ou a concordância
// preenchem, e as que ficam em branco, com o motivo. Célula com veredito só
// volta como pendente quando o veredito é o branco de "Em discussão".
function resolveDocCells(
  docId: string,
  doc: DocResponses,
  verdictFields: ReadonlyMap<string, string> | undefined,
  fields: PydanticField[],
  ctx: CellContext,
): { filled: Map<string, string>; pending: [string, string][] } {
  const filled = new Map<string, string>();
  const pending: [string, string][] = [];
  for (const field of fields) {
    if (!verdictFields?.has(field.name)) {
      const outcome = resolveCell(docId, field, doc, ctx);
      if ("value" in outcome) filled.set(field.name, outcome.value);
      else pending.push([field.name, outcome.reason]);
    } else if (ctx.discussed.has(cellKey(docId, field.name))) {
      pending.push([field.name, PENDING_REASON.discussion]);
    }
  }
  return { filled, pending };
}

function splitResponses(all: ExportResponse[] = []): DocResponses {
  return {
    all,
    humans: all.filter((r) => r.respondent_type !== "llm"),
    llm: all.find((r) => r.respondent_type === "llm"),
  };
}

// Entram nas Pendências os documentos que têm linha no Gabarito ou alguma
// codificação humana. Documento só com a resposta do LLM ainda não foi
// codificado, e listá-lo campo a campo só esconderia os brancos que importam.
function listsPending(doc: DocResponses, hasGabaritoRow: boolean): boolean {
  return hasGabaritoRow || doc.humans.length > 0;
}

// Percorre os documentos: as células preenchidas vão para `filledByDoc`, as em
// branco viram linhas de Pendências.
function resolveOpenCells(input: {
  baseDocs: ExportDocument[];
  identity: ReadonlyMap<string, DocIdentity>;
  exportableFields: PydanticField[];
  verdictsByDoc: ReadonlyMap<string, VerdictEntry>;
  responses: ExportResponse[];
  ctx: CellContext;
}): { filledByDoc: Map<string, Map<string, string>>; pendingRows: string[][] } {
  const responsesByDoc = groupBy(input.responses, (r) => r.document_id);
  const filledByDoc = new Map<string, Map<string, string>>();
  const pendingRows: string[][] = [];
  for (const { id: docId } of input.baseDocs) {
    const doc = splitResponses(responsesByDoc.get(docId));
    const verdictFields = input.verdictsByDoc.get(docId)?.fields;
    const { filled, pending } = resolveDocCells(docId, doc, verdictFields, input.exportableFields, input.ctx);
    if (filled.size > 0) filledByDoc.set(docId, filled);
    if (!listsPending(doc, filled.size > 0 || verdictFields !== undefined)) continue;
    const { displayId, title } = input.identity.get(docId)!;
    for (const [fieldName, reason] of pending) pendingRows.push([displayId, title, fieldName, reason]);
  }
  return { filledByDoc, pendingRows };
}

export function assembleExport(input: AssembleInput): ExportDataset {
  const { projectName, fields, documents, responses, reviews } = input;

  const exportableFields = fields.filter(
    (f) => f.target !== "llm_only" && f.target !== "none"
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

  const fieldByName = new Map<string, PydanticField>();
  for (const f of fields) if (!fieldByName.has(f.name)) fieldByName.set(f.name, f);
  const verdictsByDoc = buildVerdictsByDoc(baseReviews, fieldByName);
  applyExportResolutions(verdictsByDoc, input.errorResolutions ?? [], identity, fieldNameSet);
  const { filledByDoc, pendingRows } = resolveOpenCells({
    baseDocs,
    identity,
    exportableFields,
    verdictsByDoc,
    responses: baseResponses,
    ctx: buildCellContext(input, baseReviews),
  });

  // Documentos com gabarito (veredicto, auto-revisão ou concordância), na ordem da base.
  const gabaritoIds = baseDocs
    .map((d) => d.id)
    .filter((id) => verdictsByDoc.has(id) || filledByDoc.has(id));
  const gabaritoSet = new Set(gabaritoIds);

  // Prioridade por campo: veredicto do revisor (com as decisões do LLM
  // Insights) > auto-revisão decidida > concordância > vazio.
  const verdictFieldValue = (docId: string, fieldName: string): string =>
    verdictsByDoc.get(docId)?.fields.get(fieldName) ??
    filledByDoc.get(docId)?.get(fieldName) ??
    "";

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
      ];
    });

  const csvSheet: ExportSheet = {
    headers: [
      ...CONTROL_COLUMNS,
      ...auxHeaders,
      ...fieldNames,
      REVIEWER_COMMENTS,
    ],
    rows: [...responseCsvRows, ...verdictCsvRows, ...documentoCsvRows],
  };

  return {
    projectName,
    documents: documentsSheet,
    responses: responsesSheet,
    verdicts: verdictsSheet,
    pending: pendingSheet,
    csv: csvSheet,
  };
}
