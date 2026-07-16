import { describe, it, expect } from "vitest";
import {
  computeBacklogRows,
  filterCurrentMemberResponses,
  type HumanResponseRow,
  type LlmResponseRow,
} from "@/lib/auto-review-backlog";
import type { PydanticField } from "@/lib/types";

// Testes das funções puras extraídas de regenerateAutoReviewBacklog (issue
// #392) — sem I/O, então não precisam do mock de Supabase. O agrupamento de
// equivalências em si (buildEquivalenceMap) já é testado em
// lib/__tests__/compare-queue.test.ts — reaproveitado aqui em vez de
// reimplementado (revisão do PR #404).

const field: PydanticField = {
  name: "campo1",
  type: "text",
  options: null,
  description: "Campo de teste",
};

it("não recria backlog para respostas históricas de membro removido", () => {
  const responses: HumanResponseRow[] = [
    {
      id: "current-response",
      document_id: "doc1",
      respondent_id: "current-member",
      answers: {},
      answer_field_hashes: null,
    },
    {
      id: "removed-response",
      document_id: "doc2",
      respondent_id: "removed-member",
      answers: {},
      answer_field_hashes: null,
    },
  ];

  expect(filterCurrentMemberResponses(responses, ["current-member"]))
    .toEqual([responses[0]]);
});

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

  it("gera o conjunto canônico de field_reviews quando humano e LLM divergem", () => {
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

  it("equivalência registrada funde humano e LLM, eliminando a divergência", () => {
    const llmByDocId = new Map([["doc1", llm({})]]);
    const equivByDoc = new Map([
      [
        "doc1",
        new Map([
          [
            "campo1",
            [{ id: "eq1", response_a_id: "human1", response_b_id: "llm1", reviewer_id: null }],
          ],
        ]),
      ],
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
