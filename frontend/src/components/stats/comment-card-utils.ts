import type { ReviewInvalidReason } from "@/lib/review-validity";
import { formatVerdictDisplay } from "@/lib/verdict-display";

export { TYPE_LABELS, TYPE_COLORS } from "@/lib/field-labels";

export interface ResponseSnapshotEntry {
  id: string;
  respondent_name: string;
  respondent_type: "humano" | "llm";
  answer: unknown;
  justification?: string;
}

export interface ReviewComment {
  id: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  fieldHelpText?: string;
  fieldOptions?: string[] | null;
  fieldType?: "single" | "multi" | "text" | "date";
  verdict: string;
  comment: string;
  reviewerName: string;
  resolvedAt: string | null;
  createdAt: string;
  chosenResponseId: string | null;
  /**
   * Só em comentário de review cujo veredito não é mais gabarito: o motivo
   * (`review-validity.ts`), que a tela usa para rotulá-lo (#758).
   */
  verdictInvalidReason?: ReviewInvalidReason;
  /**
   * Só em comentário de review com veredito "Ambíguo" cujo texto o comentário
   * kind='ambiguity' da célula repete: o card da ambiguidade sai da lista, e
   * este responde também pelo filtro "Campos ambíguos" (`buildOrderedComments`).
   */
  coversAmbiguityComment?: true;
  source:
    | "review"
    | "nota"
    | "sugestao"
    | "dificuldade"
    | "anotacao"
    | "duvida"
    | "exclusao";
  responseSnapshot: ResponseSnapshotEntry[] | null;
  suggestionId?: string;
  suggestionStatus?: "pending" | "approved" | "rejected";
  suggestionChanges?: {
    description?: string;
    help_text?: string | null;
    options?: string[] | null;
  };
  fieldSnapshot?: {
    description: string;
    help_text: string | null;
    options: string[] | null;
  };
  difficultyResponseId?: string;
  difficultyDocumentId?: string;
  duvidaReviewId?: string;
  duvidaRespondentId?: string;
  /** Para exclusao_request — id do project_comment, status e document_id alvo. */
  exclusionCommentId?: string;
  exclusionDocumentId?: string;
  exclusionStatus?: "pending" | "approved" | "rejected";
  exclusionRejectedReason?: string | null;
}

/**
 * Tipo do comentário para o seletor "tipo" da aba Comentários. Dois tipos com
 * nome parecido e conteúdo distinto (#680): `ambiguo` casa o comentário que o
 * revisor escreveu num veredito "Ambíguo" (`reviews.verdict`), e
 * `ambiguidade` casa o comentário de discussão que esse veredito cria para o
 * campo (`project_comments.kind = 'ambiguity'`).
 */
export type CommentFilterType =
  | "answer"
  | "ambiguo"
  | "ambiguidade"
  | "pular"
  | "nota"
  | "sugestao"
  | "dificuldade"
  | "anotacao"
  | "duvida"
  | "exclusao";

// Se o comentário entra no filtro de tipo escolhido. O card da revisão que
// ficou no lugar do comentário de ambiguidade repetido responde pelos dois
// tipos (#680).
export function matchesCommentFilter(
  comment: Pick<ReviewComment, "verdict" | "coversAmbiguityComment">,
  filter: string,
): boolean {
  if (filter === "all" || commentFilterType(comment.verdict) === filter) return true;
  return filter === "ambiguidade" && comment.coversAmbiguityComment === true;
}

export function commentFilterType(verdict: string): CommentFilterType {
  if (verdict === "nota") return "nota";
  if (verdict === "anotacao") return "anotacao";
  if (verdict === "ambiguidade") return "ambiguidade";
  if (verdict === "dificuldade") return "dificuldade";
  if (verdict === "sugestao") return "sugestao";
  if (verdict === "exclusao") return "exclusao";
  if (verdict === "duvida") return "duvida";
  if (verdict === "ambiguo") return "ambiguo";
  if (verdict === "pular") return "pular";
  return "answer";
}

export function formatVerdictLabel(verdict: string): string {
  if (verdict === "nota") return "Nota do pesquisador";
  if (verdict === "anotacao") return "Anotação";
  if (verdict === "ambiguidade") return "Campo ambíguo";
  if (verdict === "dificuldade") return "Dificuldade do LLM";
  if (verdict === "sugestao") return "Sugestão";
  if (verdict === "exclusao") return "Sugestão de exclusão";
  if (verdict === "duvida") return "Dúvida do gabarito";
  if (verdict === "ambiguo") return "Ambíguo";
  if (verdict === "pular") return "Pular";
  // O `multi` em JSON vira a lista das opções marcadas; o resto, como está.
  return formatVerdictDisplay(verdict);
}

export function verdictVariant(
  verdict: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (verdict === "nota") return "secondary";
  if (verdict === "anotacao") return "secondary";
  if (verdict === "ambiguidade") return "secondary";
  if (verdict === "dificuldade") return "secondary";
  if (verdict === "sugestao") return "outline";
  if (verdict === "exclusao") return "destructive";
  if (verdict === "duvida") return "secondary";
  if (verdict === "ambiguo") return "secondary";
  if (verdict === "pular") return "outline";
  return "default";
}
