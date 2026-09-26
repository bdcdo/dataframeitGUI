import { describe, it, expect } from "vitest";
import {
  computeReviewedDocuments,
  computeTruncation,
  fetchReviewBaseData,
  gabaritoReviews,
  REVIEW_BASE_DATA_LIMIT,
  resolveViewedRespondentId,
  type ReviewRow,
} from "@/lib/reviews/queries";
import { buildReviewLookupMaps } from "@/lib/reviews/lookup-maps";
import type { PydanticField } from "@/lib/types";
import type { ErrorDecision } from "@/lib/error-resolution";
import { resolutionFixture } from "@/lib/__tests__/error-resolution-fixture";
import { makeSupabaseMock } from "@/actions/__tests__/supabase-mock";

describe("buildReviewLookupMaps", () => {
  it("indexa campos e usa título, ID externo e ID como fallback do documento", () => {
    const fields = [
      { name: "resultado", type: "text", options: null, description: "" },
    ] as PydanticField[];
    const documents = [
      { id: "d1", title: "Título", external_id: "ext-1" },
      { id: "d2", title: null, external_id: "ext-2" },
      { id: "d3", title: null, external_id: null },
    ];

    const { fieldMap, docMap } = buildReviewLookupMaps(fields, documents);

    expect(fieldMap.get("resultado")).toBe(fields[0]);
    expect([...docMap]).toEqual([
      ["d1", "Título"],
      ["d2", "ext-2"],
      ["d3", "d3"],
    ]);
  });
});

// Array esparso: `.length` e o teto sem alocar 50k elementos.
const atLimit = () => Array(REVIEW_BASE_DATA_LIMIT);
const belowLimit = () => Array(REVIEW_BASE_DATA_LIMIT - 1);

describe("computeTruncation — flags do TruncationBanner (issue #105)", () => {
  it("nenhuma tabela no teto → todas false", () => {
    expect(computeTruncation(belowLimit(), belowLimit(), belowLimit())).toEqual({
      responses: false,
      reviews: false,
      documents: false,
    });
  });

  it("marca apenas a tabela que atingiu o teto", () => {
    expect(computeTruncation(atLimit(), belowLimit(), belowLimit())).toEqual({
      responses: true,
      reviews: false,
      documents: false,
    });
    expect(computeTruncation(belowLimit(), atLimit(), belowLimit())).toEqual({
      responses: false,
      reviews: true,
      documents: false,
    });
    expect(computeTruncation(belowLimit(), belowLimit(), atLimit())).toEqual({
      responses: false,
      reviews: false,
      documents: true,
    });
  });

  it("todas no teto → todas true", () => {
    expect(computeTruncation(atLimit(), atLimit(), atLimit())).toEqual({
      responses: true,
      reviews: true,
      documents: true,
    });
  });

  it("query que falhou (null) nao conta como truncada", () => {
    expect(computeTruncation(null, null, null)).toEqual({
      responses: false,
      reviews: false,
      documents: false,
    });
  });

  it("array vazio nao conta como truncado", () => {
    expect(computeTruncation([], [], [])).toEqual({
      responses: false,
      reviews: false,
      documents: false,
    });
  });
});

// Invariante de segurança: em "Meu Gabarito", `viewAsUser` (ver o gabarito de
// outro respondente) só vale para coordenador/criador/master. A policy RLS
// "Members view responses" não filtra por respondent_id, então esta função é a
// única barreira — por isso `isCoordinator` aqui é fail-closed.
describe("resolveViewedRespondentId — viewAsUser só para coordenador/criador/master", () => {
  const ownMemberUserId = "canonical-member";
  const other = "user-other";

  it("não-coordenador vê o membro canônico, mesmo passando viewAsUser", () => {
    expect(
      resolveViewedRespondentId({
        ownMemberUserId,
        isCoordinator: false,
        viewAsUser: other,
      }),
    ).toBe(ownMemberUserId);
  });

  it("coordenador pode ver as respostas de outro via viewAsUser", () => {
    expect(
      resolveViewedRespondentId({
        ownMemberUserId,
        isCoordinator: true,
        viewAsUser: other,
      }),
    ).toBe(other);
  });

  it("sem viewAsUser, sempre o membro canônico (mesmo coordenador)", () => {
    expect(
      resolveViewedRespondentId({
        ownMemberUserId,
        isCoordinator: true,
        viewAsUser: undefined,
      }),
    ).toBe(ownMemberUserId);
  });

  it("viewAsUser vazio é tratado como ausente (não impersona)", () => {
    expect(
      resolveViewedRespondentId({
        ownMemberUserId,
        isCoordinator: true,
        viewAsUser: "",
      }),
    ).toBe(ownMemberUserId);
  });
});

describe("gabaritoReviews: a pergunta, e não a rodada, decide (#758)", () => {
  const field = { id: "00000000-0000-4000-8000-000000000001", name: "x", type: "text", options: null, description: "", hash: "aaaaaaaaaaaa" } as PydanticField;
  const fields = new Map([["x", field], ["y", { ...field, name: "y" }]]);
  const row = (id: string, overrides: Partial<ReviewRow> = {}): ReviewRow => ({
    id, document_id: "d1", field_name: "x", verdict: "sim", chosen_response_id: null,
    comment: null, reviewer_id: null, created_at: "2026-01-01T00:00:00Z", field_hash: "aaaaaaaaaaaa", ...overrides,
  });

  it("descarta veredito sobre outra versão da pergunta e mantém o da pergunta atual", () => {
    expect(gabaritoReviews([row("r1", { field_hash: "ffffffffffff" }), row("r2", { field_name: "y" })], fields))
      .toEqual([row("r2", { field_name: "y" })]);
  });

  it("entre vereditos válidos da mesma célula, vence o mais recente por created_at", () => {
    expect(gabaritoReviews([row("r2"), row("r1", { created_at: "2026-02-01T00:00:00Z" })], fields).map((r) => r.id))
      .toEqual(["r1"]);
  });

  it("empate de created_at desempata pelo maior id; query falhada (null) vira vazio", () => {
    expect(gabaritoReviews([row("r1"), row("r2")], fields).map((r) => r.id)).toEqual(["r2"]);
    expect(gabaritoReviews(null, fields)).toEqual([]);
  });
});

// A decisão do LLM Insights que depende da fonte ("Em discussão", "Ambos
// corretos") vale enquanto a review de origem vale, seja ela a escolhida da
// célula ou não. Dois revisores arbitraram a célula, os dois vereditos valem,
// e a decisão foi dada sobre o mais antigo: o Gabarito aplica a decisão.
describe("fetchReviewBaseData: decisão ancorada em veredito válido que não é o escolhido da célula", () => {
  const HASH = "aaaaaaaaaaaa";
  const x = { id: "00000000-0000-4000-8000-000000000001", name: "x", type: "text", description: "Pergunta", options: null, hash: HASH } as PydanticField;
  const reviewRow = (id: string, reviewer: string, created_at: string) => ({
    id, document_id: "doc1", field_name: "x", verdict: "Humano", chosen_response_id: "rh", comment: null,
    reviewer_id: reviewer, created_at, field_hash: HASH,
  });

  it.each<[ErrorDecision, string]>([["discussion", "ambiguo"], ["both_correct", "Humano"]])(
    "%s sobre o veredito mais antigo vale no Gabarito",
    async (decision, verdict) => {
      const resolution = resolutionFixture(decision);
      resolution.context!.source = { kind: "comparacao", id: "antiga", verdict: "Humano" };
      resolution.current_context = structuredClone(resolution.context);
      const client = makeSupabaseMock({
        tableResults: {
          projects: { data: { pydantic_fields: [x], pydantic_hash: null, created_by: "owner" } },
          responses: { data: [
            { id: "rllm", document_id: "doc1", respondent_id: null, respondent_type: "llm", respondent_name: "LLM", answers: { x: "LLM" }, justifications: null, is_latest: true, pydantic_hash: null, answer_field_hashes: { x: HASH }, created_at: "2026-09-01T00:00:00Z" },
            { id: "rh", document_id: "doc1", respondent_id: "ana", respondent_type: "humano", respondent_name: "Ana", answers: { x: "Humano" }, justifications: null, is_latest: true, pydantic_hash: null, answer_field_hashes: { x: HASH }, created_at: "2026-09-01T00:00:00Z" },
          ] },
          reviews: { data: [reviewRow("nova", "bia", "2026-09-03T00:00:00Z"), reviewRow("antiga", "caio", "2026-09-02T00:00:00Z")] },
          documents: { data: [{ id: "doc1", title: "Documento", external_id: null }] },
          profiles: { data: [] },
        },
        rpcResults: { read_error_resolutions: { data: [resolution] } },
      });

      const ctx = await fetchReviewBaseData(client as never, "p1");
      const [doc] = computeReviewedDocuments(ctx);

      expect(doc.fields[0].verdict).toBe(verdict);
      expect(doc.fields[0].resolutionLabel).toBeTruthy();
    },
  );
});
