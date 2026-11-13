import { describe, expect, it } from "vitest";
import {
  buildAutoReviewVerdictSheets,
  cycleStatus,
  reviewerDisplayName,
  DEFAULT_AUTO_REVIEW_VERDICTS,
  type AutoReviewVerdictData,
  type AutoReviewVerdictRow,
} from "@/lib/export/auto-review-verdicts";
import type { PydanticField } from "@/lib/types";

const fields = [
  { name: "q_a", type: "single", options: ["Sim", "Não"], description: "Pergunta A?", hash: "hA" },
  { name: "q_b", type: "text", options: null, description: "Pergunta B?", hash: "hB" },
] as unknown as PydanticField[];

function row(over: Partial<AutoReviewVerdictRow>): AutoReviewVerdictRow {
  return {
    id: "r",
    document_id: "d1",
    field_name: "q_a",
    self_verdict: "ambiguo",
    self_justification: null,
    self_reviewer_id: "u1",
    human_answer_snapshot: "Sim",
    llm_answer_snapshot: "Não",
    llm_justification_snapshot: "porque sim",
    final_verdict: null,
    arbitrator_comment: null,
    field_hash: "hA",
    cycle_no: 1,
    superseded_at: null,
    superseded_reason: null,
    ...over,
  };
}

function data(reviews: AutoReviewVerdictRow[], includeArchived = false): AutoReviewVerdictData {
  return {
    projectName: "P",
    fields,
    documents: [
      { id: "d1", external_id: "N-10", title: "Doc 10" },
      { id: "d2", external_id: "N-2", title: "Doc 2" },
      { id: "d3", external_id: null, title: null },
    ],
    reviews,
    reviewers: [
      { id: "u1", name: "Ana" },
      { id: "u2", name: "Bia" },
    ],
    includeArchived,
  };
}

const defaults = { verdicts: DEFAULT_AUTO_REVIEW_VERDICTS, reviewerId: null, includeArchived: false };

describe("buildAutoReviewVerdictSheets — linhas", () => {
  it("monta a linha com as colunas do script, mais pesquisador e comentário do árbitro", () => {
    const { review } = buildAutoReviewVerdictSheets(
      data([
        row({
          id: "r1",
          self_verdict: "contesta_llm",
          self_justification: "o texto diz sim",
          human_answer_snapshot: ["A", "B"],
          llm_answer_snapshot: { x: "1", y: "" },
          final_verdict: "humano",
          arbitrator_comment: "ok",
        }),
      ]),
      defaults,
    );
    expect(review.headers).toEqual([
      "Veredito do pesquisador",
      "Pesquisador",
      "ID do documento",
      "Título",
      "Pergunta",
      "Enunciado",
      "Resposta do pesquisador",
      "Resposta do LLM",
      "Justificativa do LLM",
      "Justificativa do pesquisador",
      "Decisão final (arbitragem)",
      "Comentário do árbitro",
      "Nova decisão",
      "Observação",
    ]);
    expect(review.rows).toEqual([
      [
        "Manteve a resposta (contestou o LLM)",
        "Ana",
        "N-10",
        "Doc 10",
        "q_a",
        "Pergunta A?",
        "A; B",
        "x: 1",
        "porque sim",
        "o texto diz sim",
        "Pesquisador",
        "ok",
        "",
        "",
      ],
    ]);
  });

  it("contestado sem decisão sai como aguardando arbitragem; os demais em branco", () => {
    const { review } = buildAutoReviewVerdictSheets(
      data([
        row({ id: "r1", self_verdict: "contesta_llm" }),
        row({ id: "r2", self_verdict: "admite_erro", document_id: "d2" }),
        row({ id: "r3", self_verdict: "contesta_llm", document_id: "d2", final_verdict: "llm" }),
      ]),
      defaults,
    );
    expect(review.rows.map((r) => [r[2], r[10]])).toEqual([
      ["N-2", "LLM"],
      ["N-10", "Aguardando arbitragem"],
      ["N-2", ""],
    ]);
  });

  it("ordena por veredito, pela ordem da pergunta no formulário e pelo id do documento (numérico)", () => {
    const { review } = buildAutoReviewVerdictSheets(
      data([
        row({ id: "1", self_verdict: "admite_erro", document_id: "d1" }),
        row({ id: "2", self_verdict: "ambiguo", field_name: "q_b", field_hash: "hB", document_id: "d1" }),
        row({ id: "3", self_verdict: "ambiguo", document_id: "d1" }),
        row({ id: "4", self_verdict: "ambiguo", document_id: "d2" }),
        row({ id: "5", self_verdict: "contesta_llm", document_id: "d3" }),
      ]),
      defaults,
    );
    expect(review.rows.map((r) => `${r[0]}|${r[4]}|${r[2]}`)).toEqual([
      "Ambíguo|q_a|N-2",
      "Ambíguo|q_a|N-10",
      "Ambíguo|q_b|N-10",
      "Manteve a resposta (contestou o LLM)|q_a|d3",
      "Aceitou o LLM (admitiu erro)|q_a|N-10",
    ]);
  });

  it("descarta documento fora da base (excluído)", () => {
    const { review } = buildAutoReviewVerdictSheets(data([row({ document_id: "excluido" })]), defaults);
    expect(review.rows).toEqual([]);
  });

  it("filtra por veredito: 'equivalente' fica de fora por padrão e entra quando pedido", () => {
    const reviews = [row({ id: "1", self_verdict: "equivalente" }), row({ id: "2", self_verdict: "ambiguo" })];
    expect(buildAutoReviewVerdictSheets(data(reviews), defaults).review.rows).toHaveLength(1);
    const withEquivalent = buildAutoReviewVerdictSheets(data(reviews), {
      ...defaults,
      verdicts: ["equivalente"],
    });
    expect(withEquivalent.review.rows.map((r) => r[0])).toEqual(["Equivalente"]);
  });

  it("filtra por pesquisador e usa o id quando o nome é desconhecido", () => {
    const reviews = [
      row({ id: "1", self_reviewer_id: "u1" }),
      row({ id: "2", self_reviewer_id: "u2", document_id: "d2" }),
      row({ id: "3", self_reviewer_id: "u9", document_id: "d3" }),
    ];
    const onlyBia = buildAutoReviewVerdictSheets(data(reviews), { ...defaults, reviewerId: "u2" });
    expect(onlyBia.review.rows.map((r) => r[1])).toEqual(["Bia"]);
    const all = buildAutoReviewVerdictSheets(data(reviews), defaults);
    expect(all.review.rows.map((r) => r[1]).sort()).toEqual(["Ana", "Bia", "u9"]);
  });
});

describe("buildAutoReviewVerdictSheets — ciclos que não valem mais", () => {
  const reviews = [
    row({ id: "vig", cycle_no: 2 }),
    row({ id: "arq", cycle_no: 1, superseded_at: "2026-01-01T00:00:00Z", superseded_reason: "question_changed" }),
    row({ id: "corrida", document_id: "d2", field_hash: "hA-antigo" }),
    row({ id: "removida", document_id: "d3", field_name: "q_sumiu", field_hash: "hX" }),
  ];

  it("por padrão só os vigentes, sem a coluna Situação", () => {
    const { review, reviewWidths } = buildAutoReviewVerdictSheets(data(reviews, true), defaults);
    expect(review.rows).toHaveLength(1);
    expect(review.headers).not.toContain("Situação");
    expect(reviewWidths).toHaveLength(review.headers.length);
  });

  it("com includeArchived entram todos, com a situação, o vigente antes do arquivado da mesma célula", () => {
    const { review, reviewWidths } = buildAutoReviewVerdictSheets(data(reviews, true), {
      ...defaults,
      includeArchived: true,
    });
    const status = review.headers.indexOf("Situação");
    expect(status).toBe(12);
    expect(reviewWidths).toHaveLength(review.headers.length);
    expect(review.rows.map((r) => `${r[2]}|${r[4]}|${r[status]}`)).toEqual([
      "N-2|q_a|Pergunta alterada",
      "N-10|q_a|Vigente",
      "N-10|q_a|Arquivado: pergunta alterada",
      "d3|q_sumiu|Pergunta removida",
    ]);
  });

  it("ciclo que não vale mais e não foi arbitrado não aparece como aguardando arbitragem", () => {
    const { review } = buildAutoReviewVerdictSheets(
      data(
        [
          row({ id: "a", self_verdict: "contesta_llm", superseded_at: "t", superseded_reason: "answer_changed" }),
          row({ id: "b", self_verdict: "contesta_llm", document_id: "d2", field_hash: "velho" }),
          row({ id: "c", self_verdict: "contesta_llm", document_id: "d3", final_verdict: "llm", superseded_at: "t", superseded_reason: "answer_changed" }),
        ],
        true,
      ),
      { ...defaults, includeArchived: true },
    );
    expect(review.rows.map((r) => `${r[2]}|${r[10]}`)).toEqual(["d3|LLM", "N-2|", "N-10|"]);
  });

  it("o Resumo conta células: só os vigentes nos vereditos, os demais em coluna própria", () => {
    const { summary } = buildAutoReviewVerdictSheets(data(reviews, true), { ...defaults, includeArchived: true });
    expect(summary).toEqual({
      headers: ["Pergunta", "Ambíguo", "Contestou o LLM", "Aceitou o LLM", "Total", "Ciclos que não valem mais"],
      rows: [
        ["q_a", "1", "0", "0", "1", "2"],
        ["q_sumiu", "0", "0", "0", "0", "1"],
      ],
    });
  });

  it("a opção não tem efeito se os dados vieram sem os arquivados", () => {
    const { review } = buildAutoReviewVerdictSheets(data(reviews, false), { ...defaults, includeArchived: true });
    expect(review.headers).not.toContain("Situação");
    expect(review.rows).toHaveLength(1);
  });
});

describe("cycleStatus", () => {
  const field = { hash: "h" };
  it.each([
    [{ superseded_at: null, superseded_reason: null, field_hash: "h" }, field, "Vigente"],
    [{ superseded_at: null, superseded_reason: null, field_hash: null }, field, "Vigente"],
    [{ superseded_at: null, superseded_reason: null, field_hash: "x" }, field, "Pergunta alterada"],
    [{ superseded_at: null, superseded_reason: null, field_hash: "h" }, undefined, "Pergunta removida"],
    [{ superseded_at: "t", superseded_reason: "answer_changed", field_hash: "h" }, field, "Arquivado: resposta do pesquisador mudou"],
    [{ superseded_at: "t", superseded_reason: null, field_hash: "h" }, field, "Arquivado"],
    [{ superseded_at: "t", superseded_reason: "motivo_novo", field_hash: "h" }, field, "Arquivado"],
  ])("%j → %s", (review, f, expected) => {
    expect(cycleStatus(review, f)).toBe(expected);
  });
});

describe("buildAutoReviewVerdictSheets — Resumo", () => {
  it("conta por pergunta, na ordem do formulário, só os vereditos pedidos e só as linhas exportadas", () => {
    const { summary } = buildAutoReviewVerdictSheets(
      data([
        row({ id: "1", field_name: "q_b", field_hash: "hB", self_verdict: "ambiguo" }),
        row({ id: "2", self_verdict: "contesta_llm" }),
        row({ id: "3", self_verdict: "contesta_llm", document_id: "d2" }),
        row({ id: "4", self_verdict: "admite_erro", document_id: "d3" }),
        row({ id: "5", self_verdict: "equivalente", document_id: "d3", field_name: "q_b", field_hash: "hB" }),
        row({ id: "6", self_verdict: "ambiguo", document_id: "excluido" }),
      ]),
      defaults,
    );
    expect(summary).toEqual({
      headers: ["Pergunta", "Ambíguo", "Contestou o LLM", "Aceitou o LLM", "Total"],
      rows: [
        ["q_a", "0", "2", "1", "3"],
        ["q_b", "1", "0", "0", "1"],
      ],
    });
  });
});

describe("reviewerDisplayName", () => {
  it("nome completo, senão o usuário do e-mail, senão o id", () => {
    expect(reviewerDisplayName({ id: "u", first_name: "Ana", last_name: "Silva", email: "a@x" })).toBe("Ana Silva");
    expect(reviewerDisplayName({ id: "u", first_name: null, last_name: null, email: "ana.s@x.com" })).toBe("ana.s");
    expect(reviewerDisplayName({ id: "u", first_name: null, last_name: null, email: null })).toBe("u");
  });
});
