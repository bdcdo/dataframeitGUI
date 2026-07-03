import type { PydanticField } from "@/lib/types";
import type { ReviewComment } from "@/components/stats/comment-card-utils";

/* ── Raw row shapes (subset de colunas realmente usadas por cada mapper) ── */

export interface ReviewRow {
  id: string;
  document_id: string;
  field_name: string;
  verdict: string;
  comment: string | null;
  chosen_response_id: string | null;
  resolved_at: string | null;
  reviewer_id: string | null;
  created_at: string;
  response_snapshot: unknown;
}

export interface NoteResponseRow {
  id: string;
  document_id: string;
  respondent_name: string | null;
  justifications: Record<string, string> | null;
  created_at: string;
}

export interface SuggestionRow {
  id: string;
  field_name: string;
  suggested_changes: Record<string, unknown>;
  reason: string | null;
  status: string;
  resolved_at: string | null;
  created_at: string;
  profiles: { email: string | null } | null;
}

export interface LlmResponseRow {
  id: string;
  document_id: string;
  answers: Record<string, unknown>;
  respondent_name: string | null;
  created_at: string;
}

export interface VerdictQuestionRow {
  review_id: string;
  respondent_id: string;
  comment: string;
  resolved_at: string | null;
  created_at: string;
  reviews: {
    id: string;
    document_id: string;
    field_name: string;
    verdict: string;
  };
}

export interface ProjectCommentRow {
  id: string;
  document_id: string | null;
  field_name: string | null;
  body: string;
  resolved_at: string | null;
  created_at: string;
  kind: "note" | "exclusion_request" | "ambiguity";
  rejected_at: string | null;
  rejected_reason: string | null;
  profiles: { email: string | null } | null;
}

/* ── Mapping functions ── */

export function mapReviewComments(
  reviews: ReviewRow[],
  docMap: Map<string, string>,
  fieldMap: Map<string, PydanticField>,
  reviewerMap: Map<string, string>,
): ReviewComment[] {
  return reviews.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    documentTitle: docMap.get(r.document_id) || r.document_id,
    fieldName: r.field_name,
    fieldDescription: fieldMap.get(r.field_name)?.description || r.field_name,
    fieldHelpText: fieldMap.get(r.field_name)?.help_text,
    fieldOptions: fieldMap.get(r.field_name)?.options,
    fieldType: fieldMap.get(r.field_name)?.type,
    verdict: r.verdict,
    comment: r.comment!,
    reviewerName: r.reviewer_id
      ? reviewerMap.get(r.reviewer_id) || "Anônimo"
      : "Anônimo",
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    chosenResponseId: r.chosen_response_id,
    source: "review",
    responseSnapshot:
      (r.response_snapshot as ReviewComment["responseSnapshot"]) ?? null,
  }));
}

export function mapNoteComments(
  responsesWithNotes: NoteResponseRow[],
  docMap: Map<string, string>,
  noteResolvedMap: Map<string, string | null>,
): ReviewComment[] {
  return responsesWithNotes
    .filter((r) => {
      const j = r.justifications;
      return j && typeof j._notes === "string" && j._notes.trim().length > 0;
    })
    .map((r) => ({
      id: `nota-${r.id}`,
      documentId: r.document_id,
      documentTitle: docMap.get(r.document_id) || r.document_id,
      fieldName: "(geral)",
      fieldDescription: "Nota do pesquisador",
      verdict: "nota",
      comment: r.justifications!._notes,
      reviewerName: r.respondent_name || "Anônimo",
      resolvedAt: noteResolvedMap.get(r.id) ?? null,
      createdAt: r.created_at,
      chosenResponseId: null,
      source: "nota" as const,
      responseSnapshot: null,
    }));
}

export function mapSuggestionComments(
  suggestions: SuggestionRow[],
  fieldMap: Map<string, PydanticField>,
): ReviewComment[] {
  return suggestions.map((s) => {
    const changes = s.suggested_changes;
    const currentField = fieldMap.get(s.field_name);
    return {
      id: `sugestao-${s.id}`,
      documentId: "",
      documentTitle: "",
      fieldName: s.field_name,
      fieldDescription: currentField?.description || s.field_name,
      fieldHelpText: currentField?.help_text,
      fieldOptions: currentField?.options,
      fieldType: currentField?.type,
      verdict: "sugestao",
      comment: s.reason || "Sem motivo",
      reviewerName: s.profiles?.email?.split("@")[0] || "Anônimo",
      resolvedAt: s.resolved_at,
      createdAt: s.created_at,
      chosenResponseId: null,
      source: "sugestao" as const,
      responseSnapshot: null,
      suggestionId: s.id,
      suggestionStatus: s.status as "pending" | "approved" | "rejected",
      suggestionChanges: {
        description:
          typeof changes.description === "string" ? changes.description : undefined,
        help_text:
          changes.help_text === null || typeof changes.help_text === "string"
            ? (changes.help_text as string | null)
            : undefined,
        options: Array.isArray(changes.options)
          ? (changes.options as string[])
          : changes.options === null
            ? null
            : undefined,
      },
      fieldSnapshot: {
        description: currentField?.description ?? "",
        help_text: currentField?.help_text ?? null,
        options: currentField?.options ?? null,
      },
    };
  });
}

export function mapDifficultyComments(
  llmResponses: LlmResponseRow[],
  docMap: Map<string, string>,
  fieldMap: Map<string, PydanticField>,
  resolvedDiffMap: Map<string, string | null>,
): ReviewComment[] {
  // Dificuldades do LLM vêm do campo llm_ambiguidades — conecta o comentário
  // a esse campo para que o EditFieldDialog inline funcione. Se o campo foi
  // removido do schema, cai no "(geral)" e o editor inline não é exposto.
  const ambiguitiesField = fieldMap.get("llm_ambiguidades");
  const difficultyFieldName = ambiguitiesField ? "llm_ambiguidades" : "(geral)";

  const difficultyComments: ReviewComment[] = [];
  for (const r of llmResponses) {
    const ambiguidades = r.answers?.llm_ambiguidades;
    if (
      !ambiguidades ||
      (typeof ambiguidades === "string" && !ambiguidades.trim())
    ) {
      continue;
    }
    difficultyComments.push({
      id: `dificuldade-${r.id}`,
      documentId: r.document_id,
      documentTitle: docMap.get(r.document_id) || r.document_id,
      fieldName: difficultyFieldName,
      fieldDescription: ambiguitiesField?.description || "Dificuldade do LLM",
      fieldHelpText: ambiguitiesField?.help_text,
      fieldOptions: ambiguitiesField?.options,
      fieldType: ambiguitiesField?.type,
      verdict: "dificuldade",
      comment: String(ambiguidades),
      reviewerName: r.respondent_name || "LLM",
      resolvedAt: resolvedDiffMap.get(r.id) || null,
      createdAt: r.created_at,
      chosenResponseId: null,
      source: "dificuldade" as const,
      responseSnapshot: null,
      difficultyResponseId: r.id,
      difficultyDocumentId: r.document_id,
    });
  }
  return difficultyComments;
}

export function mapDuvidaComments(
  verdictQuestions: VerdictQuestionRow[],
  docMap: Map<string, string>,
  fieldMap: Map<string, PydanticField>,
  reviewerMap: Map<string, string>,
): ReviewComment[] {
  return verdictQuestions.map((q) => {
    const r = q.reviews;
    return {
      id: `duvida-${q.review_id}-${q.respondent_id}`,
      documentId: r.document_id,
      documentTitle: docMap.get(r.document_id) || r.document_id,
      fieldName: r.field_name,
      fieldDescription: fieldMap.get(r.field_name)?.description || r.field_name,
      fieldHelpText: fieldMap.get(r.field_name)?.help_text,
      fieldOptions: fieldMap.get(r.field_name)?.options,
      fieldType: fieldMap.get(r.field_name)?.type,
      verdict: "duvida",
      comment: q.comment,
      reviewerName: reviewerMap.get(q.respondent_id) || "Anônimo",
      resolvedAt: q.resolved_at,
      createdAt: q.created_at,
      chosenResponseId: null,
      source: "duvida" as const,
      responseSnapshot: null,
      duvidaReviewId: q.review_id,
      duvidaRespondentId: q.respondent_id,
    };
  });
}

// Map project_comments — separa entre anotacoes livres e sugestoes de
// exclusao. Para sugestoes aprovadas, o doc esta excluido — o titulo vem de
// excludedDocTitles (buscado a parte pelo caller, ja que documents exclui
// registros com excluded_at != null do docMap principal).
export function mapProjectComments(
  projectComments: ProjectCommentRow[],
  docMap: Map<string, string>,
  excludedDocTitles: Map<string, string>,
  fieldMap: Map<string, PydanticField>,
): { annotationComments: ReviewComment[]; exclusionComments: ReviewComment[] } {
  function titleForDocId(docId: string | null): string {
    if (!docId) return "";
    return docMap.get(docId) || excludedDocTitles.get(docId) || docId;
  }

  const exclusionRows = projectComments.filter(
    (c) => c.kind === "exclusion_request",
  );
  const noteRows = projectComments.filter((c) => c.kind !== "exclusion_request");

  const annotationComments: ReviewComment[] = noteRows.map((c) => ({
    id: `anotacao-${c.id}`,
    documentId: c.document_id || "",
    documentTitle: titleForDocId(c.document_id),
    fieldName: c.field_name || "(geral)",
    fieldDescription: c.field_name
      ? fieldMap.get(c.field_name)?.description || c.field_name
      : "Anotação livre",
    verdict: "anotacao",
    comment: c.body,
    reviewerName: c.profiles?.email?.split("@")[0] || "Anônimo",
    resolvedAt: c.resolved_at,
    createdAt: c.created_at,
    chosenResponseId: null,
    source: "anotacao" as const,
    responseSnapshot: null,
  }));

  const exclusionComments: ReviewComment[] = exclusionRows.map((c) => {
    const status: "pending" | "approved" | "rejected" = c.rejected_at
      ? "rejected"
      : c.resolved_at
        ? "approved"
        : "pending";
    return {
      id: `exclusao-${c.id}`,
      documentId: c.document_id || "",
      documentTitle: titleForDocId(c.document_id),
      fieldName: "(geral)",
      fieldDescription: "Sugestão de exclusão",
      verdict: "exclusao",
      comment: c.body,
      reviewerName: c.profiles?.email?.split("@")[0] || "Anônimo",
      resolvedAt: c.resolved_at,
      createdAt: c.created_at,
      chosenResponseId: null,
      source: "exclusao" as const,
      responseSnapshot: null,
      exclusionCommentId: c.id,
      exclusionDocumentId: c.document_id || undefined,
      exclusionStatus: status,
      exclusionRejectedReason: c.rejected_reason,
    };
  });

  return { annotationComments, exclusionComments };
}

// Pending suggestions e exclusoes primeiro, demais por data.
export function buildOrderedComments(input: {
  reviewComments: ReviewComment[];
  noteComments: ReviewComment[];
  difficultyComments: ReviewComment[];
  duvidaComments: ReviewComment[];
  annotationComments: ReviewComment[];
  suggestionComments: ReviewComment[];
  exclusionComments: ReviewComment[];
}): ReviewComment[] {
  const {
    reviewComments,
    noteComments,
    difficultyComments,
    duvidaComments,
    annotationComments,
    suggestionComments,
    exclusionComments,
  } = input;

  const pendingSuggestions = suggestionComments.filter(
    (s) => s.suggestionStatus === "pending",
  );
  const pendingExclusions = exclusionComments.filter(
    (e) => e.exclusionStatus === "pending",
  );
  const restComments = [
    ...reviewComments,
    ...noteComments,
    ...difficultyComments,
    ...duvidaComments,
    ...annotationComments,
    ...suggestionComments.filter((s) => s.suggestionStatus !== "pending"),
    ...exclusionComments.filter((e) => e.exclusionStatus !== "pending"),
  ].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return [...pendingExclusions, ...pendingSuggestions, ...restComments];
}
