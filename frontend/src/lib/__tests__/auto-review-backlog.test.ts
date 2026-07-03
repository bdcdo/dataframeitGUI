import { describe, it, expect } from "vitest";
import {
  computeBacklogRows,
  diffReviewsToRemove,
  type HumanResponseRow,
  type LlmResponseRow,
  type ExistingFieldReviewRow,
  type FieldReviewRow,
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

  it("gera assignment + field_review quando humano e LLM divergem", () => {
    const llmByDocId = new Map([["doc1", llm({})]]);
    const { assignmentRows, fieldReviewRows, regenerated } = computeBacklogRows(
      "proj1",
      [human({})],
      llmByDocId,
      new Map(),
      [field],
    );

    expect(regenerated).toBe(1);
    expect(assignmentRows).toEqual([
      {
        project_id: "proj1",
        document_id: "doc1",
        user_id: "user1",
        type: "auto_revisao",
        status: "pendente",
      },
    ]);
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

describe("diffReviewsToRemove", () => {
  function review(overrides: Partial<ExistingFieldReviewRow>): ExistingFieldReviewRow {
    return {
      id: "fr1",
      document_id: "doc1",
      field_name: "campo1",
      self_verdict: null,
      ...overrides,
    };
  }

  it("marca para deletar reviews pendentes fora do conjunto correto", () => {
    const correct: FieldReviewRow[] = [];
    const { idsToDelete, keptResolved } = diffReviewsToRemove(
      [review({ id: "stale1" })],
      correct,
    );
    expect(idsToDelete).toEqual(["stale1"]);
    expect(keptResolved).toBe(0);
  });

  it("preserva reviews já resolvidos (self_verdict != null) mesmo fora do conjunto correto", () => {
    const { idsToDelete, keptResolved } = diffReviewsToRemove(
      [review({ id: "resolved1", self_verdict: "admite_erro" })],
      [],
    );
    expect(idsToDelete).toEqual([]);
    expect(keptResolved).toBe(1);
  });

  it("não toca reviews que estão no conjunto correto", () => {
    const correct: FieldReviewRow[] = [
      {
        project_id: "proj1",
        document_id: "doc1",
        field_name: "campo1",
        human_response_id: "h1",
        llm_response_id: "l1",
        self_reviewer_id: "u1",
      },
    ];
    const { idsToDelete, keptResolved } = diffReviewsToRemove(
      [review({ id: "current1" })],
      correct,
    );
    expect(idsToDelete).toEqual([]);
    expect(keptResolved).toBe(0);
  });
});
