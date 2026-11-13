// Planilha dos vereditos da auto-revisão: o "último filtro" do coordenador
// antes da decisão final. Uma linha por ciclo de `field_reviews` com
// veredito do pesquisador, mais a aba "Resumo" por pergunta. Sem I/O: a action
// `getAutoReviewVerdicts` lê as linhas, e o card filtra e monta aqui, sem nova
// ida ao banco a cada troca de filtro.
//
// Hoje o veredito se espalha por três telas (ambíguo vira comentário,
// contestado vai à Arbitragem, erro admitido aparece no LLM Insights), e o
// export geral não o traz. A especificação veio do script manual do Zolgensma
// (`zolgensma-coleta/scripts/revisao.py`).
//
// Ciclo que não vale mais: o arquivado (`superseded_at`) e o vigente cuja
// pergunta mudou (`fieldReviewIsCurrent`, a corrida descrita em
// 20260927130000_judgments_follow_question.sql). Por padrão ficam de fora,
// porque o veredito foi dado sobre outra versão da pergunta ou da resposta;
// com `includeArchived` entram, com a coluna "Situação" dizendo o motivo.
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
  /** Se `reviews` traz os ciclos arquivados. */
  includeArchived: boolean;
}

export interface AutoReviewVerdictFilters {
  verdicts: readonly SelfVerdict[];
  /** `null` = todos os pesquisadores. */
  reviewerId: string | null;
  /** Precisa de `AutoReviewVerdictData.includeArchived` para ter efeito. */
  includeArchived: boolean;
}

export interface AutoReviewVerdictSheets {
  review: ExportSheet;
  summary: ExportSheet;
  /** Largura (em caracteres) de cada coluna de `review`. */
  reviewWidths: number[];
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

function arbitrationLabel(review: AutoReviewVerdictRow): string {
  if (review.final_verdict) return ARBITRATION_LABELS[review.final_verdict];
  return review.self_verdict === "contesta_llm" ? "Aguardando arbitragem" : "";
}

const BASE_HEADERS = [
  "Veredito do pesquisador",
  "Pesquisador",
  "ID do documento",
  "Título",
  "Pergunta",
  "Enunciado",
  "Resposta do pesquisador",
  "Resposta do LLM",
  "Justificativa do LLM",
  "Justificativa do pesquisador",
  "Decisão final (arbitragem)",
  "Comentário do árbitro",
];
const BASE_WIDTHS = [24, 20, 14, 30, 26, 50, 30, 30, 50, 40, 16, 30];
const STATUS_HEADER = "Situação";
const STATUS_WIDTH = 28;
const EDITABLE_HEADERS = ["Nova decisão", "Observação"];
const EDITABLE_WIDTHS = [20, 30];

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
  const includeArchived = filters.includeArchived && data.includeArchived;
  const verdicts = new Set(filters.verdicts);
  const fieldByName = new Map(data.fields.map((field) => [field.name, field]));
  const fieldOrder = new Map(data.fields.map((field, index) => [field.name, index]));
  const documentById = new Map(data.documents.map((doc) => [doc.id, doc]));
  const reviewerName = new Map(data.reviewers.map((reviewer) => [reviewer.id, reviewer.name]));
  const verdictRank = new Map(AUTO_REVIEW_VERDICTS.map((verdict, index) => [verdict, index]));
  const documentKey = (doc: AutoReviewVerdictDocument) => doc.external_id || doc.id;

  const rows = data.reviews.flatMap((review) => {
    const doc = documentById.get(review.document_id);
    if (!doc || !verdicts.has(review.self_verdict)) return [];
    if (filters.reviewerId !== null && review.self_reviewer_id !== filters.reviewerId) return [];
    const status = cycleStatus(review, fieldByName.get(review.field_name));
    if (!includeArchived && status !== CYCLE_STATUS_CURRENT) return [];
    return [{ review, doc, status }];
  });

  const unknownField = data.fields.length;
  rows.sort(
    (a, b) =>
      verdictRank.get(a.review.self_verdict)! - verdictRank.get(b.review.self_verdict)! ||
      (fieldOrder.get(a.review.field_name) ?? unknownField) -
        (fieldOrder.get(b.review.field_name) ?? unknownField) ||
      a.review.field_name.localeCompare(b.review.field_name) ||
      documentKey(a.doc).localeCompare(documentKey(b.doc), "pt-BR", { numeric: true }) ||
      Number(b.status === CYCLE_STATUS_CURRENT) - Number(a.status === CYCLE_STATUS_CURRENT) ||
      b.review.cycle_no - a.review.cycle_no ||
      a.review.id.localeCompare(b.review.id),
  );

  const review: ExportSheet = {
    headers: [
      ...BASE_HEADERS,
      ...(includeArchived ? [STATUS_HEADER] : []),
      ...EDITABLE_HEADERS,
    ],
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
      arbitrationLabel(row),
      row.arbitrator_comment ?? "",
      ...(includeArchived ? [status] : []),
      "",
      "",
    ]),
  };

  // O Resumo conta só o que está na aba de revisão, e só os vereditos pedidos.
  const summaryVerdicts = AUTO_REVIEW_VERDICTS.filter((verdict) => verdicts.has(verdict));
  const counts = new Map<string, Map<SelfVerdict, number>>();
  for (const { review: row } of rows) {
    const byVerdict = counts.get(row.field_name) ?? new Map<SelfVerdict, number>();
    byVerdict.set(row.self_verdict, (byVerdict.get(row.self_verdict) ?? 0) + 1);
    counts.set(row.field_name, byVerdict);
  }
  const summaryFields = [...counts.keys()].sort(
    (a, b) =>
      (fieldOrder.get(a) ?? unknownField) - (fieldOrder.get(b) ?? unknownField) || a.localeCompare(b),
  );
  const summary: ExportSheet = {
    headers: ["Pergunta", ...summaryVerdicts.map((verdict) => SELF_VERDICT_SHORT_LABELS[verdict]), "Total"],
    rows: summaryFields.map((fieldName) => {
      const byVerdict = counts.get(fieldName)!;
      const cells = summaryVerdicts.map((verdict) => byVerdict.get(verdict) ?? 0);
      return [fieldName, ...cells.map(String), String(cells.reduce((sum, n) => sum + n, 0))];
    }),
  };

  return {
    review,
    summary,
    reviewWidths: [...BASE_WIDTHS, ...(includeArchived ? [STATUS_WIDTH] : []), ...EDITABLE_WIDTHS],
  };
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
