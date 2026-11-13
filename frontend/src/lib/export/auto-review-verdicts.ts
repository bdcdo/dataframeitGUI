// Planilha dos vereditos da auto-revisão, o "último filtro" do coordenador
// antes da decisão final: uma linha por ciclo com veredito do pesquisador,
// mais a aba "Resumo" por pergunta. Sem I/O: a action `getAutoReviewVerdicts`
// lê os ciclos, e o card filtra e monta aqui, sem nova ida ao banco. A
// especificação veio do script manual do Zolgensma
// (`zolgensma-coleta/scripts/revisao.py`).
//
// Ciclo que não vale mais: o arquivado (`superseded_at`), que o banco move
// para `field_review_cycle_history_entries`, e o vigente cuja pergunta mudou
// (`fieldReviewIsCurrent`, a corrida descrita em
// 20260927130000_judgments_follow_question.sql). Por padrão ficam de fora,
// porque o veredito foi dado sobre outra versão da pergunta ou da resposta;
// com `includeArchived` entram, com a coluna "Situação" dizendo o motivo. Uma
// célula pode então ter várias linhas (uma por ciclo), e o Resumo continua
// contando células: só os ciclos vigentes entram nas colunas de veredito, e
// os demais vão para a coluna "Ciclos que não valem mais".
//
// Puro e client-safe.
import type { PydanticField, SelfVerdict } from "@/lib/types";
import { fieldReviewIsCurrent } from "@/lib/review-validity";
import { formatExportValue } from "./format";
import type { ExportSheet } from "./assemble";

/** Linha de `field_reviews` com as colunas que a planilha usa. */
export interface AutoReviewVerdictRow {
  id: string;
  document_id: string;
  field_name: string;
  self_verdict: SelfVerdict;
  self_justification: string | null;
  self_reviewer_id: string;
  human_answer_snapshot: unknown;
  llm_answer_snapshot: unknown;
  llm_justification_snapshot: unknown;
  final_verdict: "humano" | "llm" | null;
  arbitrator_comment: string | null;
  field_hash: string | null;
  cycle_no: number;
  superseded_at: string | null;
  superseded_reason: string | null;
}

export interface AutoReviewVerdictDocument {
  id: string;
  external_id: string | null;
  title: string | null;
}

export interface AutoReviewReviewer {
  id: string;
  name: string;
}

/** O que a action devolve: as linhas cruas, já recortadas pelo banco. */
export interface AutoReviewVerdictData {
  projectName: string;
  fields: PydanticField[];
  documents: AutoReviewVerdictDocument[];
  reviews: AutoReviewVerdictRow[];
  /** Pesquisadores com ao menos um ciclo, em ordem de nome. */
  reviewers: AutoReviewReviewer[];
}

export interface AutoReviewVerdictFilters {
  verdicts: readonly SelfVerdict[];
  /** `null` = todos os pesquisadores. */
  reviewerId: string | null;
  /** Os dados precisam ter sido lidos com a mesma opção (o card recarrega). */
  includeArchived: boolean;
}

export interface AutoReviewVerdictSheets {
  review: ExportSheet;
  summary: ExportSheet;
}

/** Ordem da planilha e dos controles: do mais ao menos urgente. */
export const AUTO_REVIEW_VERDICTS: readonly SelfVerdict[] = [
  "ambiguo",
  "contesta_llm",
  "admite_erro",
  "equivalente",
];

/** Os três do script; `equivalente` é opcional. */
export const DEFAULT_AUTO_REVIEW_VERDICTS: readonly SelfVerdict[] = [
  "ambiguo",
  "contesta_llm",
  "admite_erro",
];

const SELF_VERDICT_LABELS: Record<SelfVerdict, string> = {
  ambiguo: "Ambíguo",
  contesta_llm: "Manteve a resposta (contestou o LLM)",
  admite_erro: "Aceitou o LLM (admitiu erro)",
  equivalente: "Equivalente",
};

/** Rótulo curto, para o Resumo e para os controles do card. */
export const SELF_VERDICT_SHORT_LABELS: Record<SelfVerdict, string> = {
  ambiguo: "Ambíguo",
  contesta_llm: "Contestou o LLM",
  admite_erro: "Aceitou o LLM",
  equivalente: "Equivalente",
};

const ARBITRATION_LABELS: Record<"humano" | "llm", string> = {
  humano: "Pesquisador",
  llm: "LLM",
};

const CYCLE_STATUS_CURRENT = "Vigente";

// Os motivos do CHECK `field_reviews_superseded_reason_check`.
const SUPERSEDED_REASON_LABELS: Record<string, string> = {
  answer_changed: "Arquivado: resposta do pesquisador mudou",
  llm_changed: "Arquivado: resposta do LLM mudou",
  no_longer_divergent: "Arquivado: deixou de divergir",
  legacy_response_changed: "Arquivado: resposta mudou (legado)",
  question_changed: "Arquivado: pergunta alterada",
  field_removed: "Arquivado: pergunta removida",
};

/**
 * A situação do ciclo: "Vigente", ou por que ele não vale mais. O ciclo não
 * arquivado de pergunta alterada é o que escapou do gatilho do save do schema.
 */
export function cycleStatus(
  review: Pick<AutoReviewVerdictRow, "superseded_at" | "superseded_reason" | "field_hash">,
  field: Pick<PydanticField, "hash"> | undefined,
): string {
  if (review.superseded_at !== null) {
    return (review.superseded_reason && SUPERSEDED_REASON_LABELS[review.superseded_reason]) || "Arquivado";
  }
  if (!field) return "Pergunta removida";
  if (!fieldReviewIsCurrent(review.field_hash, field)) return "Pergunta alterada";
  return CYCLE_STATUS_CURRENT;
}

// Ciclo que não vale mais e não foi arbitrado nunca será: não está aguardando.
function arbitrationLabel(review: AutoReviewVerdictRow, status: string): string {
  if (review.final_verdict) return ARBITRATION_LABELS[review.final_verdict];
  const pending = review.self_verdict === "contesta_llm" && status === CYCLE_STATUS_CURRENT;
  return pending ? "Aguardando arbitragem" : "";
}

// Colunas da aba de revisão e a largura de cada uma, em caracteres.
const BASE_COLUMNS: Array<[string, number]> = [
  ["Veredito do pesquisador", 24],
  ["Pesquisador", 20],
  ["ID do documento", 14],
  ["Título", 30],
  ["Pergunta", 26],
  ["Enunciado", 50],
  ["Resposta do pesquisador", 30],
  ["Resposta do LLM", 30],
  ["Justificativa do LLM", 50],
  ["Justificativa do pesquisador", 40],
  ["Decisão final (arbitragem)", 16],
  ["Comentário do árbitro", 30],
];
const STATUS_COLUMN: [string, number] = ["Situação", 28];
const EDITABLE_COLUMNS: Array<[string, number]> = [
  ["Nova decisão", 20],
  ["Observação", 30],
];
const STALE_HEADER = "Ciclos que não valem mais";

/** Largura de cada coluna da aba de revisão, pelo cabeçalho. */
export const AUTO_REVIEW_COLUMN_WIDTHS: Record<string, number> = Object.fromEntries([
  ...BASE_COLUMNS,
  STATUS_COLUMN,
  ...EDITABLE_COLUMNS,
]);

// Um só collator: com locale e opções, `localeCompare` monta um por chamada.
const collator = new Intl.Collator("pt-BR", { numeric: true });

/**
 * Monta as duas abas a partir das linhas e dos filtros. Documento fora da base
 * (excluído) e verdito fora de `filters.verdicts` saem; ciclo que não vale
 * mais só entra com `includeArchived`. A ordem é a do script: veredito, ordem
 * da pergunta no formulário, documento; dentro da célula, o vigente primeiro
 * e depois o ciclo mais recente.
 */
export function buildAutoReviewVerdictSheets(
  data: AutoReviewVerdictData,
  filters: AutoReviewVerdictFilters,
): AutoReviewVerdictSheets {
  const { includeArchived } = filters;
  // A coluna ou célula que só existe com os ciclos que não valem mais.
  const ifArchived = <T,>(item: T): T[] => (includeArchived ? [item] : []);
  const verdicts = new Set(filters.verdicts);
  const fieldByName = new Map(data.fields.map((field) => [field.name, field]));
  const fieldOrder = new Map(data.fields.map((field, index) => [field.name, index]));
  const documentById = new Map(data.documents.map((doc) => [doc.id, doc]));
  const reviewerName = new Map(data.reviewers.map((reviewer) => [reviewer.id, reviewer.name]));
  const verdictRank = new Map(AUTO_REVIEW_VERDICTS.map((verdict, index) => [verdict, index]));
  const documentKey = (doc: AutoReviewVerdictDocument) => doc.external_id || doc.id;
  // Ordem da pergunta no formulário; pergunta fora dele vai ao fim, por nome.
  const compareField = (a: string, b: string) =>
    (fieldOrder.get(a) ?? data.fields.length) - (fieldOrder.get(b) ?? data.fields.length) ||
    collator.compare(a, b);

  const rows = data.reviews.flatMap((review) => {
    const doc = documentById.get(review.document_id);
    if (!doc || !verdicts.has(review.self_verdict)) return [];
    if (filters.reviewerId !== null && review.self_reviewer_id !== filters.reviewerId) return [];
    const status = cycleStatus(review, fieldByName.get(review.field_name));
    const current = status === CYCLE_STATUS_CURRENT;
    if (!includeArchived && !current) return [];
    return [{ review, doc, status, current }];
  });

  rows.sort(
    (a, b) =>
      verdictRank.get(a.review.self_verdict)! - verdictRank.get(b.review.self_verdict)! ||
      compareField(a.review.field_name, b.review.field_name) ||
      collator.compare(documentKey(a.doc), documentKey(b.doc)) ||
      Number(b.current) - Number(a.current) ||
      b.review.cycle_no - a.review.cycle_no ||
      collator.compare(a.review.id, b.review.id),
  );

  const columns = [...BASE_COLUMNS, ...ifArchived(STATUS_COLUMN), ...EDITABLE_COLUMNS];
  const review: ExportSheet = {
    headers: columns.map(([header]) => header),
    rows: rows.map(({ review: row, doc, status }) => [
      SELF_VERDICT_LABELS[row.self_verdict],
      reviewerName.get(row.self_reviewer_id) ?? row.self_reviewer_id,
      documentKey(doc),
      doc.title ?? "",
      row.field_name,
      fieldByName.get(row.field_name)?.description ?? "",
      formatExportValue(row.human_answer_snapshot),
      formatExportValue(row.llm_answer_snapshot),
      formatExportValue(row.llm_justification_snapshot),
      row.self_justification ?? "",
      arbitrationLabel(row, status),
      row.arbitrator_comment ?? "",
      ...ifArchived(status),
      "",
      "",
    ]),
  };

  // O Resumo conta só o que está na aba de revisão, e só os vereditos pedidos.
  // Nas colunas de veredito entram só os ciclos vigentes (um por célula); os
  // que não valem mais têm coluna própria.
  const summaryVerdicts = AUTO_REVIEW_VERDICTS.filter((verdict) => verdicts.has(verdict));
  const counts = new Map<string, { byVerdict: Map<SelfVerdict, number>; stale: number }>();
  for (const { review: row, current } of rows) {
    const count = counts.get(row.field_name) ?? { byVerdict: new Map(), stale: 0 };
    if (current) count.byVerdict.set(row.self_verdict, (count.byVerdict.get(row.self_verdict) ?? 0) + 1);
    else count.stale += 1;
    counts.set(row.field_name, count);
  }
  const summary: ExportSheet = {
    headers: [
      "Pergunta",
      ...summaryVerdicts.map((verdict) => SELF_VERDICT_SHORT_LABELS[verdict]),
      "Total",
      ...ifArchived(STALE_HEADER),
    ],
    rows: [...counts.keys()].sort(compareField).map((fieldName) => {
      const { byVerdict, stale } = counts.get(fieldName)!;
      const cells = summaryVerdicts.map((verdict) => byVerdict.get(verdict) ?? 0);
      const total = cells.reduce((sum, n) => sum + n, 0);
      return [fieldName, ...cells.map(String), String(total), ...ifArchived(String(stale))];
    }),
  };

  return { review, summary };
}

/** Nome do pesquisador: nome completo, ou o usuário do e-mail, ou o id. */
export function reviewerDisplayName(profile: {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}): string {
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  return fullName || profile.email?.split("@")[0] || profile.id;
}
