import { describe, it, expect } from "vitest";
import {
  computeReviewedDocuments,
  fetchReviewBaseData,
  gabaritoReviews,
  resolveViewedRespondentId,
} from "@/lib/reviews/queries";
import { buildReviewLookupMaps } from "@/lib/reviews/lookup-maps";
import type { PydanticField } from "@/lib/types";
import type { ErrorDecision } from "@/lib/error-resolution";
import { resolutionFixture } from "@/lib/__tests__/error-resolution-fixture";
import { makeFilterAwareSupabaseMock } from "@/test-utils/supabase-mock";

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

// A escolha da review por célula é de `pickValidCellReviews`, testada em
// review-validity.test.ts.
describe("gabaritoReviews", () => {
  it("query falhada (null) vira Gabarito vazio", () => {
    expect(gabaritoReviews(null, new Map())).toEqual([]);
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
    id, project_id: "p1", document_id: "doc1", field_name: "x", verdict: "Humano", chosen_response_id: "rh", comment: null,
    reviewer_id: reviewer, created_at, field_hash: HASH,
  });

  it.each<[ErrorDecision, string]>([["discussion", "ambiguo"], ["both_correct", "Humano"]])(
    "%s sobre o veredito mais antigo vale no Gabarito",
    async (decision, verdict) => {
      const resolution = resolutionFixture(decision);
      resolution.context!.source = { kind: "comparacao", id: "antiga", verdict: "Humano" };
      resolution.current_context = structuredClone(resolution.context);
      const client = makeFilterAwareSupabaseMock({
        tableData: {
          projects: [{ id: "p1", pydantic_fields: [x], pydantic_hash: null, created_by: "owner" }],
          responses: [
            { id: "rllm", project_id: "p1", document_id: "doc1", respondent_id: null, respondent_type: "llm", respondent_name: "LLM", answers: { x: "LLM" }, justifications: null, is_latest: true, pydantic_hash: null, answer_field_hashes: { x: HASH }, created_at: "2026-09-01T00:00:00Z" },
            { id: "rh", project_id: "p1", document_id: "doc1", respondent_id: "ana", respondent_type: "humano", respondent_name: "Ana", answers: { x: "Humano" }, justifications: null, is_latest: true, pydantic_hash: null, answer_field_hashes: { x: HASH }, created_at: "2026-09-01T00:00:00Z" },
          ],
          reviews: [reviewRow("nova", "bia", "2026-09-03T00:00:00Z"), reviewRow("antiga", "caio", "2026-09-02T00:00:00Z")],
          documents: [{ id: "doc1", project_id: "p1", title: "Documento", external_id: null, excluded_at: null, exclusion_pending_at: null }],
          profiles: [],
        },
        writeCalls: [],
        rpcResults: { read_error_resolutions: { data: [resolution] } },
      });

      const ctx = await fetchReviewBaseData(client as never, "p1");
      const [doc] = computeReviewedDocuments(ctx);

      expect(doc.fields[0].verdict).toBe(verdict);
      expect(doc.fields[0].resolutionLabel).toBeTruthy();
    },
  );
});

// O mapa de nomes lia `profiles.full_name`, coluna que não existe: a leitura
// voltava com erro, o mapa ficava vazio e o Gabarito mostrava a autoria
// congelada em `respondent_name` (#622).
describe("fetchReviewBaseData: autoria vem do perfil", () => {
  const HASH = "aaaaaaaaaaaa";
  const x = { id: "00000000-0000-4000-8000-000000000001", name: "x", type: "text", description: "Pergunta", options: null, hash: HASH } as PydanticField;
  const human = (id: string, respondent: string, recorded: string) => ({
    id, project_id: "p1", document_id: "doc1", respondent_id: respondent, respondent_type: "humano", respondent_name: recorded,
    answers: { x: "A" }, justifications: null, is_latest: true, pydantic_hash: null, answer_field_hashes: { x: HASH }, created_at: "2026-09-01T00:00:00Z",
  });

  it("mostra o nome do perfil, e o nome gravado para quem não tem nome no perfil", async () => {
    const client = makeFilterAwareSupabaseMock({
      tableData: {
        projects: [{ id: "p1", pydantic_fields: [x], pydantic_hash: null, created_by: "owner" }],
        responses: [human("r1", "ana", "ana@example.com"), human("r2", "bia", "bia@example.com")],
        reviews: [{ id: "rv", project_id: "p1", document_id: "doc1", field_name: "x", verdict: "A", chosen_response_id: "r1", comment: null, reviewer_id: "caio", created_at: "2026-09-02T00:00:00Z", field_hash: HASH }],
        documents: [{ id: "doc1", project_id: "p1", title: "Documento", external_id: null, excluded_at: null, exclusion_pending_at: null }],
        project_members: [
          { project_id: "p1", user_id: "ana", profiles: { first_name: "Ana", last_name: "Lima" } },
          { project_id: "p1", user_id: "bia", profiles: { first_name: null, last_name: null } },
        ],
        // Como o banco devolve a linha: sem `full_name`.
        profiles: [
          { id: "ana", first_name: "Ana", last_name: "Lima" },
          { id: "bia", first_name: null, last_name: null },
        ],
      },
      writeCalls: [],
      rpcResults: { read_error_resolutions: { data: [] } },
    });

    const ctx = await fetchReviewBaseData(client as never, "p1");
    const [doc] = computeReviewedDocuments(ctx);

    expect(doc.fields[0].respondentAnswers.map((r) => r.respondentName).toSorted()).toEqual(["Ana Lima", "bia@example.com"]);
    expect(ctx.responsesByDoc.get("doc1")?.map((r) => r.respondent_name).toSorted()).toEqual(["Ana Lima", "bia@example.com"]);
  });
});

// As leituras tinham `.limit(50000)`, mas o PostgREST corta em `max_rows`
// (1000) sem erro: o Gabarito de um projeto maior saía com as primeiras 1000
// linhas de cada tabela como se fossem todas.
describe("fetchReviewBaseData: lê as tabelas inteiras, página a página", () => {
  const HASH = "aaaaaaaaaaaa";
  const x = { id: "00000000-0000-4000-8000-000000000001", name: "x", type: "text", description: "Pergunta", options: null, hash: HASH } as PydanticField;
  // Acima de uma página do cursor (1000), sem ser múltiplo dela.
  const TOTAL = 1203;
  const docId = (i: number) => `doc-${String(i).padStart(5, "0")}`;
  const docs = Array.from({ length: TOTAL }, (_, i) => docId(i));
  const tableData = () => ({
    projects: [{ id: "p1", pydantic_fields: [x], pydantic_hash: null, created_by: "owner" }],
    responses: docs.map((doc) => ({
      id: `r-${doc}`, project_id: "p1", document_id: doc, respondent_id: "ana", respondent_type: "humano", respondent_name: "Ana",
      answers: { x: "A" } as Record<string, string>, justifications: null, is_latest: true, pydantic_hash: null,
      answer_field_hashes: { x: HASH } as Record<string, string>, created_at: "2026-09-01T00:00:00Z",
    })),
    reviews: docs.map((doc) => ({
      id: `rv-${doc}`, project_id: "p1", document_id: doc, field_name: "x", verdict: "A", chosen_response_id: `r-${doc}`, comment: null,
      reviewer_id: "caio", created_at: "2026-09-02T00:00:00Z", field_hash: HASH,
    })),
    documents: docs.map((doc) => ({ id: doc, project_id: "p1", title: `Título ${doc}`, external_id: null, excluded_at: null, exclusion_pending_at: null })),
    profiles: [],
  });

  it("documentos, respostas e revisões além da primeira página chegam ao Gabarito", async () => {
    const client = makeFilterAwareSupabaseMock({
      tableData: tableData(), writeCalls: [], rpcResults: { read_error_resolutions: { data: [] } },
    });

    const ctx = await fetchReviewBaseData(client as never, "p1");
    const reviewed = computeReviewedDocuments(ctx);

    expect(ctx.docMap.size).toBe(TOTAL);
    expect(ctx.responsesByDoc.size).toBe(TOTAL);
    expect(ctx.uniqueReviews).toHaveLength(TOTAL);
    expect(reviewed).toHaveLength(TOTAL);
    const last = reviewed.find((doc) => doc.documentId === docId(TOTAL - 1));
    expect(last?.documentTitle).toBe(`Título ${docId(TOTAL - 1)}`);
    expect(last?.fields[0].respondentAnswers).toHaveLength(1);
  });

  it("os respondentes de um documento saem na ordem de gravação, não na da PK", async () => {
    const data = tableData();
    data.responses = [
      { ...data.responses[0], id: "r-b", respondent_id: "bia", respondent_name: "Bia", created_at: "2026-09-01T00:00:00Z" },
      { ...data.responses[0], id: "r-a", respondent_id: "ana", respondent_name: "Ana", created_at: "2026-09-03T00:00:00Z" },
    ];
    const client = makeFilterAwareSupabaseMock({
      tableData: data, writeCalls: [], rpcResults: { read_error_resolutions: { data: [] } },
    });

    const ctx = await fetchReviewBaseData(client as never, "p1");

    expect(ctx.responsesByDoc.get(docId(0))?.map((r) => r.id)).toEqual(["r-b", "r-a"]);
  });

  it.each(["projects", "responses", "reviews", "documents"])("erro na leitura de %s falha alto em vez de montar o Gabarito sem a tabela", async (table) => {
    const client = makeFilterAwareSupabaseMock({
      tableData: tableData(), writeCalls: [], rpcResults: { read_error_resolutions: { data: [] } },
      queryErrors: { [`${table}:select`]: { message: "gateway fora" } },
    });

    await expect(fetchReviewBaseData(client as never, "p1")).rejects.toThrow("gateway fora");
  });

  it("erro na leitura das decisões falha alto em vez de montar o Gabarito sem elas", async () => {
    const client = makeFilterAwareSupabaseMock({
      tableData: tableData(), writeCalls: [], rpcResults: { read_error_resolutions: { data: null, error: { message: "gateway fora" } } },
    });

    await expect(fetchReviewBaseData(client as never, "p1")).rejects.toThrow("gateway fora");
  });

  it("os campos de um documento saem na ordem do schema, não na da PK das revisões", async () => {
    const y = { ...x, id: "00000000-0000-4000-8000-000000000002", name: "y" } as PydanticField;
    const data = tableData();
    data.projects[0].pydantic_fields = [x, y];
    data.responses = [{ ...data.responses[0], answers: { x: "A", y: "A" }, answer_field_hashes: { x: HASH, y: HASH } }];
    // A PK da revisão de `y` vem antes da de `x`.
    data.reviews = [
      { ...data.reviews[0], id: "rv-2", field_name: "x" },
      { ...data.reviews[0], id: "rv-1", field_name: "y" },
    ];
    const client = makeFilterAwareSupabaseMock({
      tableData: data, writeCalls: [], rpcResults: { read_error_resolutions: { data: [] } },
    });

    const [doc] = computeReviewedDocuments(await fetchReviewBaseData(client as never, "p1"));

    expect(doc.fields.map((field) => field.fieldName)).toEqual(["x", "y"]);
  });
});
