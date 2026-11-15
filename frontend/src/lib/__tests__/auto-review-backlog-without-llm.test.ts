import { describe, expect, it } from "vitest";
import { fetchDocsWithoutLlmCount } from "@/lib/auto-review-backlog-without-llm";
import { makeHumanResponse } from "@/test-utils/comparison-fixtures";
import { makeFilterAwareSupabaseMock } from "@/test-utils/supabase-mock";

// #690: a regeneração do backlog deixa de fora, sem dizer, os documentos sem
// geração LLM corrente.

function human(id: string, documentId: string, extra: Record<string, unknown> = {}) {
  return makeHumanResponse(id, "a", { id, document_id: documentId, ...extra });
}
function llm(id: string, documentId: string, extra: Record<string, unknown> = {}) {
  return { ...human(id, documentId, extra), respondent_type: "llm" };
}

function count(
  tableData: Record<string, unknown[]>,
  queryErrors?: Record<string, { message: string } | null>,
) {
  const client = makeFilterAwareSupabaseMock({
    tableData: { projects: [{ id: "p1", automation_mode: "auto_review_llm" }], ...tableData },
    writeCalls: [],
    queryErrors,
  }) as never;
  return fetchDocsWithoutLlmCount(client, "p1");
}

describe("fetchDocsWithoutLlmCount", () => {
  it("round reiniciado: todo documento codificado conta, e o LLM corrente tira o seu", async () => {
    const result = await count({
      responses: [
        human("h1", "d1"),
        human("h2", "d1"), // dois humanos no mesmo documento contam uma vez
        human("h3", "d2"),
        human("h4", "d3"),
        llm("l3", "d3"), // d3 tem LLM corrente: entra na RPC, não aqui
        llm("l2", "d2", { is_latest: false }), // geração arquivada pelo round
        human("h5", "d4", { is_partial: true }), // humano incompleto não conta
        human("h6", "d5", { project_id: "p2" }),
      ],
    });
    expect(result).toEqual({ count: 2, error: null });
  });

  it("documento excluído ou com exclusão pendente não conta: o runner LLM o pula", async () => {
    const result = await count({
      responses: [
        human("h1", "d1"),
        human("h2", "d2", { "documents.excluded_at": "2026-11-01T00:00:00Z" }),
        human("h3", "d3", { "documents.exclusion_pending_at": "2026-11-01T00:00:00Z" }),
      ],
    });
    expect(result).toEqual({ count: 1, error: null });
  });

  it("LLM parcial não é geração corrente", async () => {
    const result = await count({
      responses: [human("h1", "d1"), llm("l1", "d1", { is_partial: true })],
    });
    expect(result).toEqual({ count: 1, error: null });
  });

  it("fora do modo de auto-revisão, só documentos com auto-revisão vigente ou em histórico", async () => {
    const result = await count({
      projects: [{ id: "p1", automation_mode: "compare_llm" }],
      responses: [human("h1", "d1"), human("h2", "d2"), human("h3", "d3")],
      field_reviews: [{ id: "f1", project_id: "p1", document_id: "d1" }],
      field_review_cycle_history_entries: [
        { id: "c1", project_id: "p1", document_id: "d2" },
        { id: "c2", project_id: "p2", document_id: "d3" },
      ],
    });
    expect(result).toEqual({ count: 2, error: null });
  });

  it("pagina além das 1000 linhas do PostgREST", async () => {
    const responses = Array.from({ length: 1_500 }, (_, i) => human(`h${i}`, `d${i}`));
    expect(await count({ responses })).toEqual({ count: 1_500, error: null });
  });

  it("falha de leitura vira erro explícito, não zero", async () => {
    const result = await count(
      { responses: [human("h1", "d1")] },
      { "responses:select": { message: "boom" } },
    );
    expect(result).toEqual({ count: null, error: { message: "boom" } });
  });
});
