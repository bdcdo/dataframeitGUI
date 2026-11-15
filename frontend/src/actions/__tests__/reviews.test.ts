import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";

import {
  makeFilterAwareSupabaseMock,
  type WriteCall,
} from "@/test-utils/supabase-mock";

// Mock filter-aware: aplica os filtros das queries às linhas de `tableData`,
// então cada linha declara as colunas que submitVerdict filtra (projeto,
// documento, campo, kind, verdict). Uma linha de outra célula precisa ser
// descartada como o Postgres descartaria.
let opCalls: WriteCall[];
let tableData: Record<string, unknown[]>;

function makeClient() {
  return makeFilterAwareSupabaseMock({ tableData, writeCalls: opCalls });
}

const payloadOf = (call: WriteCall | undefined) =>
  call?.payload as Record<string, unknown> | undefined;

// Linhas da célula (p1, doc1, q1) sob teste.
const cell = { project_id: "p1", document_id: "doc1", field_name: "q1" };
const ambiguityComment = (overrides: Record<string, unknown> = {}) => ({
  id: "pc1", ...cell, kind: "ambiguity", ...overrides,
});
const ambiguousReview = (overrides: Record<string, unknown> = {}) => ({
  id: "r2", ...cell, verdict: "ambiguo", field_hash: "aaaaaaaaaaaa", ...overrides,
});
const projectRow = (pydanticFields: unknown[], id = "p1") => ({
  id, pydantic_fields: pydanticFields,
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  resolveProjectMemberActor: async () => ({
    ok: true,
    user: { id: "account-alias" },
    memberUserId: "canonical-reviewer",
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeClient(),
}));
// syncCompareAssignment resolve sem efeito por padrão. É um vi.fn para que um
// teste possa fazê-lo REJEITAR: o sync lança em erro de leitura e quando falta
// o assignment, e a action tem de absorver essa falha depois de gravar.
const { mockSyncCompareAssignment } = vi.hoisted(() => ({
  mockSyncCompareAssignment: vi.fn(async () => {}),
}));
vi.mock("@/lib/compare-sync", () => ({
  syncCompareAssignment: mockSyncCompareAssignment,
}));

beforeEach(() => {
  opCalls = [];
  tableData = {};
  mockSyncCompareAssignment.mockReset();
  mockSyncCompareAssignment.mockImplementation(async () => {});
});

async function loadSubmit() {
  return (await import("@/actions/reviews")).submitVerdict;
}

// Carga a frio fora do primeiro teste (eslint-rules/test-cold-imports.mjs).
beforeAll(async () => {
  await import("@/actions/reviews");
}, 30_000);

describe("submitVerdict — veredito ambiguo vira comentario automatico", () => {
  const PROJECT = projectRow([
    { id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "text", options: null, description: "", hash: "aaaaaaaaaaaa" },
  ]);

  it("grava o review no membro canônico e mantém a autoria na conta autenticada", async () => {
    tableData = { project_comments: [] };
    const submitVerdict = await loadSubmit();

    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "ambiguo",
    });

    expect(
      payloadOf(opCalls.find((call) => call.op === "upsert" && call.table === "reviews")),
    ).toMatchObject({ reviewer_id: "canonical-reviewer" });
    expect(
      payloadOf(opCalls.find(
        (call) => call.op === "insert" && call.table === "project_comments",
      )),
    ).toMatchObject({ author_id: "account-alias" });
  });

  it("ambiguo sem comentario existente → insere project_comments kind='ambiguity'", async () => {
    tableData = { project_comments: [] };
    const submitVerdict = await loadSubmit();
    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "ambiguo",
    });

    const insert = opCalls.find(
      (c) => c.op === "insert" && c.table === "project_comments",
    );
    expect(payloadOf(insert)).toMatchObject({
      project_id: "p1",
      document_id: "doc1",
      field_name: "q1",
      kind: "ambiguity",
      body: "Campo marcado como ambíguo na revisão (aba Comparar).",
    });
  });

  it("ambiguo com comentario do revisor → preserva o texto trimado no corpo", async () => {
    tableData = { project_comments: [] };
    const submitVerdict = await loadSubmit();
    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "ambiguo",
      comment: "  depende do contexto  ",
    });

    const insert = opCalls.find(
      (c) => c.op === "insert" && c.table === "project_comments",
    );
    expect(payloadOf(insert)?.body).toBe(
      "Campo marcado como ambíguo na revisão (aba Comparar): depende do contexto",
    );
  });

  it("ambiguo com comentario ja existente → nao insere de novo (idempotente)", async () => {
    tableData = { project_comments: [ambiguityComment()] };
    const submitVerdict = await loadSubmit();
    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "ambiguo",
    });

    expect(opCalls.some((c) => c.op === "insert")).toBe(false);
  });

  // Cada filtro da busca do comentário existente descarta o de outra célula:
  // sem ele, o ambíguo desta célula ficaria sem comentário.
  it.each([
    ["de outro projeto", { project_id: "p2" }],
    ["de outro documento", { document_id: "doc2" }],
    ["de outro campo", { field_name: "q2" }],
    ["que não é de ambiguidade", { kind: "note" }],
  ])("ambiguo com comentario %s → insere o desta célula", async (_, overrides) => {
    tableData = { project_comments: [ambiguityComment(overrides)] };
    const submitVerdict = await loadSubmit();
    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "ambiguo",
    });

    expect(
      opCalls.filter((c) => c.op === "insert" && c.table === "project_comments"),
    ).toHaveLength(1);
  });

  it("verdict nao-ambiguo e nenhum outro revisor ambiguo → deleta o comentario orfao", async () => {
    // reviews query (stillAmbiguous) retorna vazio
    tableData = { reviews: [], projects: [PROJECT] };
    const submitVerdict = await loadSubmit();
    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "concordo",
    });

    expect(
      opCalls.some((c) => c.op === "delete" && c.table === "project_comments"),
    ).toBe(true);
  });

  // #758: só veredito que ainda vale sustenta a pendência. O "ambiguo" dado
  // sobre outra versão da pergunta não é mais gabarito de ninguém.
  it("verdict nao-ambiguo e o outro ambiguo e de outra versao da pergunta → deleta", async () => {
    tableData = {
      reviews: [ambiguousReview({ field_hash: "ffffffffffff" })],
      projects: [PROJECT],
    };
    const submitVerdict = await loadSubmit();
    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "concordo",
    });

    expect(
      opCalls.some((c) => c.op === "delete" && c.table === "project_comments"),
    ).toBe(true);
  });

  // Cada filtro da busca de "ainda ambíguo" descarta o review que não sustenta
  // a pendência desta célula: sem ele, o comentário ficaria órfão.
  it.each([
    ["de outro projeto", { project_id: "p2" }],
    ["de outro documento", { document_id: "doc2" }],
    ["de outro campo", { field_name: "q2" }],
    ["que não é ambíguo", { verdict: "concordo" }],
  ])("verdict nao-ambiguo e o outro review e %s → deleta", async (_, overrides) => {
    tableData = { reviews: [ambiguousReview(overrides)], projects: [PROJECT] };
    const submitVerdict = await loadSubmit();
    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "concordo",
    });

    expect(
      opCalls.some((c) => c.op === "delete" && c.table === "project_comments"),
    ).toBe(true);
  });

  it("verdict nao-ambiguo mas outro revisor ainda marca ambiguo → nao deleta", async () => {
    tableData = {
      reviews: [ambiguousReview()],
      projects: [PROJECT],
    };
    const submitVerdict = await loadSubmit();
    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "concordo",
    });

    expect(opCalls.some((c) => c.op === "delete")).toBe(false);
  });
});

// Voto em card copia a resposta. Com o piso de versão `latest_major`, a
// Comparação mostra respostas de versões minor anteriores cujo valor pode ter
// saído das opções; gravar esse voto dava sucesso, mas o veredito nascia fora
// do domínio (`review-validity.ts`), não contava no fecho e a tela recarregada
// o mostrava como anterior à mudança da pergunta.
describe("submitVerdict: voto copiado fora das opções atuais", () => {
  const SINGLE = {
    id: "00000000-0000-4000-8000-000000000002", name: "q2", type: "single",
    options: ["Sim", "Não"], description: "", hash: "bbbbbbbbbbbb",
  };

  it.each([
    ["opção que saiu do formulário", { ...SINGLE }, "Talvez"],
    ["\"Outro: x\" depois de desligar allow_other", { ...SINGLE, allow_other: false }, "Outro: x"],
  ])("%s é recusado sem gravar", async (_label, field, verdict) => {
    tableData = { projects: [projectRow([field])] };
    const submitVerdict = await loadSubmit();

    const result = await submitVerdict({
      projectId: "p1", documentId: "doc1", fieldName: "q2", verdict, chosenResponseId: "r1",
    });

    expect(result.error).toMatch(/não está mais no formulário/);
    expect(opCalls.filter((c) => c.op === "upsert")).toHaveLength(0);
  });

  // O domínio vem do schema deste projeto, não do primeiro que a query achar.
  it("schema de outro projeto não amplia o domínio", async () => {
    tableData = {
      projects: [
        projectRow([{ ...SINGLE, options: ["Sim", "Não", "Talvez"] }], "p2"),
        projectRow([SINGLE]),
      ],
    };
    const submitVerdict = await loadSubmit();

    const result = await submitVerdict({
      projectId: "p1", documentId: "doc1", fieldName: "q2", verdict: "Talvez", chosenResponseId: "r1",
    });

    expect(result.error).toMatch(/não está mais no formulário/);
    expect(opCalls.filter((c) => c.op === "upsert")).toHaveLength(0);
  });

  it.each([
    ["opção atual", { ...SINGLE }, "Sim", "r1"],
    ["\"Outro: x\" com allow_other ligado", { ...SINGLE, allow_other: true }, "Outro: x", "r1"],
    // O digitado ("Nenhuma correta") com o hash atual vale fora das opções.
    ["veredito digitado fora das opções", { ...SINGLE }, "Não houve", undefined],
  ])("%s grava", async (_label, field, verdict, chosenResponseId) => {
    tableData = { projects: [projectRow([field])] };
    const submitVerdict = await loadSubmit();

    const result = await submitVerdict({
      projectId: "p1", documentId: "doc1", fieldName: "q2", verdict, chosenResponseId,
    });

    expect(result).toEqual({});
    expect(opCalls.filter((c) => c.op === "upsert" && c.table === "reviews")).toHaveLength(1);
  });
});

// O sync roda depois do upsert do review e fora do try que devolve `{ error }`.
// Se a falha dele subisse, o revisor veria "falha ao salvar" para um veredito
// já gravado e tentaria de novo, reescrevendo o mesmo dado.
describe("submitVerdict: falha do sync pós-commit", () => {
  it("grava o veredito, retorna {} e só loga", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSyncCompareAssignment.mockRejectedValueOnce(new Error("sync boom"));
    tableData = {
      projects: [projectRow([{ id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "text", options: null, description: "", hash: "aaaaaaaaaaaa" }])],
      reviews: [],
    };
    const submitVerdict = await loadSubmit();

    const result = await submitVerdict({
      projectId: "p1", documentId: "doc1", fieldName: "q1", verdict: "concordo",
    });

    expect(result).toEqual({});
    expect(
      opCalls.filter((c) => c.op === "upsert" && c.table === "reviews"),
    ).toHaveLength(1);
    expect(mockSyncCompareAssignment).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("sync boom");
    errorSpy.mockRestore();
  });
});
