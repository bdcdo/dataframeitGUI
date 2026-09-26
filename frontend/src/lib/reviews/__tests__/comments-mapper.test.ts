import { describe, it, expect } from "vitest";
import {
  mapReviewComments,
  mapNoteComments,
  mapSuggestionComments,
  mapDifficultyComments,
  mapDuvidaComments,
  mapProjectComments,
  buildOrderedComments,
  type ReviewCommentRow,
  type NoteResponseRow,
  type SuggestionRow,
  type LlmResponseRow,
  type VerdictQuestionRow,
  type ProjectCommentRow,
} from "@/lib/reviews/comments-mapper";
import type { PydanticField } from "@/lib/types";
import type { ReviewComment } from "@/components/stats/comment-card-utils";

const field: PydanticField = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "campo1",
  type: "text",
  options: null,
  description: "Descrição do campo",
  help_text: "Ajuda",
};
const fieldMap = new Map([[field.name, field]]);
const docMap = new Map([["doc1", "Documento 1"]]);

describe("mapReviewComments", () => {
  it("mapeia review para ReviewComment preservando reviewer e snapshot", () => {
    const review: ReviewCommentRow = {
      id: "r1",
      document_id: "doc1",
      field_name: "campo1",
      verdict: "correto",
      comment: "ok",
      chosen_response_id: "resp1",
      resolved_at: null,
      reviewer_id: "user1",
      created_at: "2026-01-01T00:00:00Z",
      response_snapshot: [{ id: "resp1", respondent_name: "Ana", respondent_type: "humano", answer: "x" }],
      field_hash: null,
    };
    const reviewerMap = new Map([["user1", "ana"]]);

    const [result] = mapReviewComments([review], docMap, fieldMap, reviewerMap);

    expect(result.documentTitle).toBe("Documento 1");
    expect(result.fieldDescription).toBe("Descrição do campo");
    expect(result.reviewerName).toBe("ana");
    expect(result.source).toBe("review");
    expect(result.responseSnapshot).toEqual(review.response_snapshot);
  });

  it("usa 'Anônimo' quando reviewer_id não está no mapa", () => {
    const review: ReviewCommentRow = {
      id: "r2",
      document_id: "doc-desconhecido",
      field_name: "campo-desconhecido",
      verdict: "incorreto",
      comment: "falta contexto",
      chosen_response_id: null,
      resolved_at: null,
      reviewer_id: "user-fora-do-mapa",
      created_at: "2026-01-01T00:00:00Z",
      response_snapshot: null,
      field_hash: null,
    };

    const [result] = mapReviewComments([review], docMap, fieldMap, new Map());

    expect(result.reviewerName).toBe("Anônimo");
    expect(result.documentTitle).toBe("doc-desconhecido");
    expect(result.fieldDescription).toBe("campo-desconhecido");
  });
});

describe("mapReviewComments: veredito que perdeu a validade (#758)", () => {
  const hashed = { ...field, hash: "aaaaaaaaaaaa" };
  const row = (field_hash: string | null, field_name = "campo1"): ReviewCommentRow => ({
    id: "r3", document_id: "doc1", field_name, verdict: "x", comment: "comentário antigo",
    chosen_response_id: null, resolved_at: null, reviewer_id: null,
    created_at: "2026-01-01T00:00:00Z", response_snapshot: null, field_hash,
  });

  it.each([
    ["mesma pergunta", row("aaaaaaaaaaaa"), undefined],
    ["pergunta alterada", row("ffffffffffff"), "pergunta_alterada"],
    ["campo removido", row("aaaaaaaaaaaa", "sumiu"), "campo_removido"],
    ["fora das opções", { ...row(null), verdict: "Talvez" }, "fora_do_dominio"],
  ])("%s: o comentário continua, e o veredito é marcado com o motivo", (_label, review, reason) => {
    const single = { ...hashed, type: "single" as const, options: ["x"] };
    const [result] = mapReviewComments([review], docMap, new Map([["campo1", single]]), new Map());
    expect(result.comment).toBe("comentário antigo");
    expect(result.verdictInvalidReason).toBe(reason);
  });
});

describe("mapNoteComments", () => {
  it("filtra respostas sem _notes e mapeia as demais", () => {
    const rows: NoteResponseRow[] = [
      {
        id: "resp1",
        document_id: "doc1",
        respondent_name: "Ana",
        justifications: { _notes: "  nota relevante  " },
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "resp2",
        document_id: "doc1",
        respondent_name: "Bia",
        justifications: { _notes: "   " },
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "resp3",
        document_id: "doc1",
        respondent_name: "Caio",
        justifications: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];

    const result = mapNoteComments(rows, docMap, new Map());

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("nota-resp1");
    expect(result[0].comment).toBe("  nota relevante  ");
  });
});

describe("mapSuggestionComments", () => {
  it("mapeia mudancas sugeridas e status pendente", () => {
    const suggestion: SuggestionRow = {
      id: "s1",
      field_name: "campo1",
      suggested_changes: { description: "Nova descrição", help_text: null, options: ["a", "b"] },
      reason: "Motivo da sugestão",
      status: "pending",
      resolved_at: null,
      created_at: "2026-01-01T00:00:00Z",
      profiles: { email: "coordenador@example.com" },
    };

    const [result] = mapSuggestionComments([suggestion], fieldMap);

    expect(result.suggestionStatus).toBe("pending");
    expect(result.reviewerName).toBe("coordenador");
    expect(result.suggestionChanges).toEqual({
      description: "Nova descrição",
      help_text: null,
      options: ["a", "b"],
    });
    expect(result.fieldSnapshot).toEqual({
      description: field.description,
      help_text: field.help_text,
      options: field.options,
    });
  });
});

describe("mapDifficultyComments", () => {
  it("ignora respostas sem ambiguidade e mapeia as demais", () => {
    const rows: LlmResponseRow[] = [
      {
        id: "llm1",
        document_id: "doc1",
        answers: { llm_ambiguidades: "texto confuso" },
        respondent_name: "LLM",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "llm2",
        document_id: "doc1",
        answers: { llm_ambiguidades: "   " },
        respondent_name: "LLM",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "llm3",
        document_id: "doc1",
        answers: {},
        respondent_name: "LLM",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];

    const result = mapDifficultyComments(rows, docMap, fieldMap, new Map());

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("dificuldade-llm1");
    expect(result[0].fieldName).toBe("(geral)");
  });

  it("usa o campo llm_ambiguidades quando presente no schema", () => {
    const ambiguitiesField: PydanticField = {
      id: "00000000-0000-4000-8000-000000000002",
      name: "llm_ambiguidades",
      type: "text",
      options: null,
      description: "Ambiguidades apontadas pelo LLM",
    };
    const rows: LlmResponseRow[] = [
      {
        id: "llm1",
        document_id: "doc1",
        answers: { llm_ambiguidades: "confuso" },
        respondent_name: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];

    const result = mapDifficultyComments(
      rows,
      docMap,
      new Map([[ambiguitiesField.name, ambiguitiesField]]),
      new Map(),
    );

    expect(result[0].fieldName).toBe("llm_ambiguidades");
    expect(result[0].reviewerName).toBe("LLM");
  });

  it("usa o fallback 'Dificuldade do LLM' quando llm_ambiguidades nao esta no schema", () => {
    const rows: LlmResponseRow[] = [
      {
        id: "llm1",
        document_id: "doc1",
        answers: { llm_ambiguidades: "confuso" },
        respondent_name: "LLM",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];

    const result = mapDifficultyComments(rows, docMap, fieldMap, new Map());

    expect(result[0].fieldName).toBe("(geral)");
    expect(result[0].fieldDescription).toBe("Dificuldade do LLM");
  });
});

describe("mapDuvidaComments", () => {
  it("mapeia dúvidas do gabarito a partir do review aninhado", () => {
    const row: VerdictQuestionRow = {
      review_id: "review1",
      respondent_id: "user1",
      comment: "por que isso está errado?",
      resolved_at: null,
      created_at: "2026-01-01T00:00:00Z",
      acknowledged_verdict: "incorreto",
      reviews: {
        id: "review1",
        document_id: "doc1",
        field_name: "campo1",
        verdict: "incorreto",
      },
    };
    const reviewerMap = new Map([["user1", "ana"]]);

    const [result] = mapDuvidaComments([row], docMap, fieldMap, reviewerMap);

    expect(result.id).toBe("duvida-review1-user1");
    expect(result.documentTitle).toBe("Documento 1");
    expect(result.reviewerName).toBe("ana");
  });

  // #758: a dúvida é sobre o veredito que o pesquisador viu. Rearbitrado o
  // veredito, ela não é mais dúvida sobre o veredito da célula.
  it("dúvida sobre veredito que mudou sai da lista", () => {
    const row: VerdictQuestionRow = {
      review_id: "review1", respondent_id: "user1", comment: "por quê?", resolved_at: null,
      created_at: "2026-01-01T00:00:00Z", acknowledged_verdict: "antigo",
      reviews: { id: "review1", document_id: "doc1", field_name: "campo1", verdict: "novo" },
    };
    expect(mapDuvidaComments([row], docMap, fieldMap, new Map())).toEqual([]);
  });
});

describe("mapProjectComments", () => {
  const baseRow: ProjectCommentRow = {
    id: "c1",
    document_id: "doc1",
    field_name: "campo1",
    body: "comentário livre",
    resolved_at: null,
    created_at: "2026-01-01T00:00:00Z",
    kind: "note",
    rejected_at: null,
    rejected_reason: null,
    profiles: { email: "pesquisador@example.com" },
  };

  it("separa anotacoes de sugestoes de exclusao", () => {
    const exclusionRow: ProjectCommentRow = {
      ...baseRow,
      id: "c2",
      kind: "exclusion_request",
      field_name: null,
    };

    const { annotationComments, exclusionComments } = mapProjectComments(
      { exclusionRows: [exclusionRow], noteRows: [baseRow] },
      docMap,
      new Map(),
      fieldMap,
    );

    expect(annotationComments).toHaveLength(1);
    expect(annotationComments[0].source).toBe("anotacao");
    expect(exclusionComments).toHaveLength(1);
    expect(exclusionComments[0].source).toBe("exclusao");
    expect(exclusionComments[0].exclusionStatus).toBe("pending");
  });

  it("usa excludedDocTitles quando o documento não está mais no docMap", () => {
    const exclusionRow: ProjectCommentRow = {
      ...baseRow,
      id: "c3",
      document_id: "doc-excluido",
      kind: "exclusion_request",
      resolved_at: "2026-02-01T00:00:00Z",
    };

    const { exclusionComments } = mapProjectComments(
      { exclusionRows: [exclusionRow], noteRows: [] },
      docMap,
      new Map([["doc-excluido", "Título do doc excluído"]]),
      fieldMap,
    );

    expect(exclusionComments[0].documentTitle).toBe("Título do doc excluído");
    expect(exclusionComments[0].exclusionStatus).toBe("approved");
  });

  it("marca status 'rejected' quando rejected_at está presente", () => {
    const exclusionRow: ProjectCommentRow = {
      ...baseRow,
      id: "c4",
      kind: "exclusion_request",
      rejected_at: "2026-02-01T00:00:00Z",
      rejected_reason: "motivo",
    };

    const { exclusionComments } = mapProjectComments(
      { exclusionRows: [exclusionRow], noteRows: [] },
      docMap,
      new Map(),
      fieldMap,
    );

    expect(exclusionComments[0].exclusionStatus).toBe("rejected");
    expect(exclusionComments[0].exclusionRejectedReason).toBe("motivo");
  });
});

describe("buildOrderedComments", () => {
  function comment(overrides: Partial<ReviewComment>): ReviewComment {
    return {
      id: "id",
      documentId: "doc1",
      documentTitle: "Documento 1",
      fieldName: "campo1",
      fieldDescription: "desc",
      verdict: "correto",
      comment: "texto",
      reviewerName: "ana",
      resolvedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      chosenResponseId: null,
      source: "review",
      responseSnapshot: null,
      ...overrides,
    };
  }

  it("coloca exclusões pendentes primeiro, depois sugestões pendentes, depois o resto por data desc", () => {
    const older = comment({ id: "old", source: "review", createdAt: "2026-01-01T00:00:00Z" });
    const newer = comment({ id: "new", source: "nota", createdAt: "2026-01-02T00:00:00Z" });
    const pendingSuggestion = comment({
      id: "sug",
      source: "sugestao",
      suggestionStatus: "pending",
      createdAt: "2025-01-01T00:00:00Z",
    });
    const pendingExclusion = comment({
      id: "exc",
      source: "exclusao",
      exclusionStatus: "pending",
      createdAt: "2025-01-01T00:00:00Z",
    });
    const resolvedSuggestion = comment({
      id: "sug-resolvida",
      source: "sugestao",
      suggestionStatus: "approved",
      createdAt: "2026-01-03T00:00:00Z",
    });

    const result = buildOrderedComments({
      reviewComments: [older],
      noteComments: [newer],
      difficultyComments: [],
      duvidaComments: [],
      annotationComments: [],
      suggestionComments: [pendingSuggestion, resolvedSuggestion],
      exclusionComments: [pendingExclusion],
    });

    expect(result.map((c) => c.id)).toEqual([
      "exc",
      "sug",
      "sug-resolvida",
      "new",
      "old",
    ]);
  });
});
