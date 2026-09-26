import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock minimo do supabase: captura insert/delete em project_comments para
// validar o comportamento do submitVerdict com veredito "ambiguo" sem subir
// Postgres. Builder chainable e thenable. Os dados retornados por tabela sao
// controlados por `tableData` (setado por teste).
type OpCall = { op: string; table: string; payload?: Record<string, unknown> };
let opCalls: OpCall[];
let tableData: Record<string, unknown>;

function makeClient() {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "neq", "not", "order", "limit"]) {
        builder[m] = () => builder;
      }
      builder.upsert = (payload: Record<string, unknown>) => {
        opCalls.push({ op: "upsert", table, payload });
        return builder;
      };
      builder.insert = (payload: Record<string, unknown>) => {
        opCalls.push({ op: "insert", table, payload });
        return builder;
      };
      builder.delete = () => {
        opCalls.push({ op: "delete", table });
        return builder;
      };
      builder.update = (payload: Record<string, unknown>) => {
        opCalls.push({ op: "update", table, payload });
        return builder;
      };
      builder.maybeSingle = async () => ({
        data: tableData[table] ?? null,
        error: null,
      });
      builder.single = async () => ({ data: tableData[table] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: tableData[table] ?? null, error: null });
      return builder;
    },
  };
}

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
// syncCompareAssignment curto-circuita: assignment ausente => retorno imediato.
vi.mock("@/lib/compare-sync", () => ({
  syncCompareAssignment: async () => {},
}));

beforeEach(() => {
  opCalls = [];
  tableData = {};
});

async function loadSubmit() {
  return (await import("@/actions/reviews")).submitVerdict;
}

describe("submitVerdict — veredito ambiguo vira comentario automatico", () => {
  const PROJECT = {
    pydantic_fields: [{ id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "text", options: null, description: "", hash: "aaaaaaaaaaaa" }],
  };

  it("grava o review no membro canônico e mantém a autoria na conta autenticada", async () => {
    tableData = { project_comments: null };
    const submitVerdict = await loadSubmit();

    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "ambiguo",
    });

    expect(
      opCalls.find((call) => call.op === "upsert" && call.table === "reviews")
        ?.payload,
    ).toMatchObject({ reviewer_id: "canonical-reviewer" });
    expect(
      opCalls.find(
        (call) => call.op === "insert" && call.table === "project_comments",
      )?.payload,
    ).toMatchObject({ author_id: "account-alias" });
  });

  it("ambiguo sem comentario existente → insere project_comments kind='ambiguity'", async () => {
    tableData = { project_comments: null };
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
    expect(insert?.payload).toMatchObject({
      project_id: "p1",
      document_id: "doc1",
      field_name: "q1",
      kind: "ambiguity",
      body: "Campo marcado como ambíguo na revisão (aba Comparar).",
    });
  });

  it("ambiguo com comentario do revisor → preserva o texto trimado no corpo", async () => {
    tableData = { project_comments: null };
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
    expect(insert?.payload?.body).toBe(
      "Campo marcado como ambíguo na revisão (aba Comparar): depende do contexto",
    );
  });

  it("ambiguo com comentario ja existente → nao insere de novo (idempotente)", async () => {
    tableData = { project_comments: { id: "pc1" } };
    const submitVerdict = await loadSubmit();
    await submitVerdict({
      projectId: "p1",
      documentId: "doc1",
      fieldName: "q1",
      verdict: "ambiguo",
    });

    expect(opCalls.some((c) => c.op === "insert")).toBe(false);
  });

  it("verdict nao-ambiguo e nenhum outro revisor ambiguo → deleta o comentario orfao", async () => {
    // reviews query (stillAmbiguous) retorna vazio
    tableData = { reviews: [], projects: PROJECT };
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
      reviews: [{ id: "r2", field_name: "q1", verdict: "ambiguo", field_hash: "ffffffffffff" }],
      projects: PROJECT,
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

  it("verdict nao-ambiguo mas outro revisor ainda marca ambiguo → nao deleta", async () => {
    tableData = {
      reviews: [{ id: "r2", field_name: "q1", verdict: "ambiguo", field_hash: "aaaaaaaaaaaa" }],
      projects: PROJECT,
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
    tableData = { projects: { pydantic_fields: [field] } };
    const submitVerdict = await loadSubmit();

    const result = await submitVerdict({
      projectId: "p1", documentId: "doc1", fieldName: "q2", verdict, chosenResponseId: "r1",
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
    tableData = { projects: { pydantic_fields: [field] } };
    const submitVerdict = await loadSubmit();

    const result = await submitVerdict({
      projectId: "p1", documentId: "doc1", fieldName: "q2", verdict, chosenResponseId,
    });

    expect(result).toEqual({});
    expect(opCalls.filter((c) => c.op === "upsert" && c.table === "reviews")).toHaveLength(1);
  });
});
