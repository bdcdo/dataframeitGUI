import { describe, it, expect } from "vitest";
import {
  computeBacklogRows,
  type HumanResponseRow,
  type LlmResponseRow,
} from "@/lib/auto-review-backlog";
import type { PydanticField } from "@/lib/types";

// Testes das funções puras extraídas de regenerateAutoReviewBacklog (issue
// #392) — sem I/O, então não precisam do mock de Supabase. O agrupamento de
// equivalências em si (`groupValueEquivalencesByField`) é testado em
// lib/__tests__/equivalence.test.ts.

const field: PydanticField = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "campo1",
  type: "text",
  options: null,
  description: "Campo de teste",
  hash: "campo1-hash",
};

describe("computeBacklogRows", () => {
  function human(overrides: Partial<HumanResponseRow>): HumanResponseRow {
    return {
      id: "human1",
      document_id: "doc1",
      respondent_id: "user1",
      answers: { campo1: "sim" },
      answer_field_hashes: null,
      ...overrides,
    };
  }
  function llm(overrides: Partial<LlmResponseRow>): LlmResponseRow {
    return {
      id: "llm1",
      document_id: "doc1",
      answers: { campo1: "nao" },
      answer_field_hashes: null,
      ...overrides,
    };
  }

  it("gera field_review quando humano e LLM divergem", () => {
    const llmByDocId = new Map([["doc1", llm({})]]);
    const { fieldReviewRows, regenerated } = computeBacklogRows(
      "proj1",
      [human({})],
      llmByDocId,
      new Map(),
      [field],
    );

    expect(regenerated).toBe(1);
    expect(fieldReviewRows).toEqual([
      {
        project_id: "proj1",
        document_id: "doc1",
        field_name: "campo1",
        human_response_id: "human1",
        llm_response_id: "llm1",
        self_reviewer_id: "user1",
      },
    ]);
  });

  it("pula quando não há resposta LLM para o documento", () => {
    const result = computeBacklogRows("proj1", [human({})], new Map(), new Map(), [field]);
    expect(result.regenerated).toBe(0);
    expect(result.fieldReviewRows).toEqual([]);
  });

  it("pula quando a codificação humana está incompleta (campo obrigatório vazio)", () => {
    const llmByDocId = new Map([["doc1", llm({})]]);
    const result = computeBacklogRows(
      "proj1",
      [human({ answers: {} })],
      llmByDocId,
      new Map(),
      [field],
    );
    expect(result.regenerated).toBe(0);
  });

  it("equivalência de valor registrada funde humano e LLM, eliminando a divergência", () => {
    const llmByDocId = new Map([["doc1", llm({})]]);
    const equivByDoc = new Map([
      ["campo1", [{
        id: "eq1",
        field_name: "campo1",
        field_hash: "campo1-hash",
        value_a: "nao",
        value_b: "sim",
        reviewer_id: null,
      }]],
    ]);

    const result = computeBacklogRows(
      "proj1",
      [human({})],
      llmByDocId,
      equivByDoc,
      [field],
    );

    expect(result.regenerated).toBe(0);
    expect(result.fieldReviewRows).toEqual([]);
  });
});

describe("computeBacklogRows: equivalência de outra versão da pergunta", () => {
  it("não funde: o campo continua divergente", () => {
    const result = computeBacklogRows(
      "proj1",
      [{ id: "human1", document_id: "doc1", respondent_id: "user1", answers: { campo1: "sim" }, answer_field_hashes: null }],
      new Map([["doc1", { id: "llm1", document_id: "doc1", answers: { campo1: "nao" }, answer_field_hashes: null }]]),
      new Map([["campo1", [{
        id: "eq1", field_name: "campo1", field_hash: "hash-antigo", value_a: "nao", value_b: "sim", reviewer_id: null,
      }]]]),
      [field],
    );
    expect(result.fieldReviewRows.map((row) => row.field_name)).toEqual(["campo1"]);
  });
});
