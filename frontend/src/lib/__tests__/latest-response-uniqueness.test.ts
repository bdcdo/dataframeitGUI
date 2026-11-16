import { describe, expect, it } from "vitest";
import {
  latestResponseUniquenessViolations,
  type LatestResponseRow,
} from "@/lib/latest-response-uniqueness";

// respondent_name viaja junto só para os testes mostrarem que ele não entra na
// chave: até a #715 entrava, no lugar do respondent_id NULL das linhas LLM.
type Row = LatestResponseRow & { respondent_name: string | null };

function row(overrides: Partial<Row> & Pick<Row, "id">): Row {
  return {
    project_id: "proj",
    round_id: "rodada-2",
    document_id: "doc",
    respondent_type: "humano",
    respondent_id: "ana",
    respondent_name: "Ana",
    ...overrides,
  };
}

const llm = (id: string, overrides: Partial<Row> = {}) =>
  row({ id, respondent_type: "llm", respondent_id: null, respondent_name: "gpt-x", ...overrides });

const violationDetails = (rows: Row[]) =>
  latestResponseUniquenessViolations(rows).map((v) => v.detail);

describe("latestResponseUniquenessViolations", () => {
  it("passa com uma resposta viva por chave de cada índice", () => {
    expect(
      latestResponseUniquenessViolations([
        row({ id: "h-ana" }),
        row({ id: "h-bia", respondent_id: "bia", respondent_name: "Bia" }),
        llm("l-1"),
        llm("l-outro-doc", { document_id: "doc-2" }),
      ]),
    ).toEqual([]);
  });

  // Chave de responses_one_latest_llm_per_document: (project_id, document_id).
  // respondent_id é NULL em toda linha LLM, e o modelo (respondent_name) não
  // entra na chave: duas LLM vivas no mesmo doc colidem mesmo vindas de
  // modelos diferentes.
  it("acusa duas LLM vivas no mesmo doc, mesmo com respondent_name diferente", () => {
    const violations = latestResponseUniquenessViolations([
      llm("l-gpt", { respondent_name: "gpt-x" }),
      llm("l-claude", { respondent_name: "claude-y" }),
    ]);
    expect(violations).toEqual([
      { key: "llm|proj|doc", detail: "2 responses is_latest: l-gpt, l-claude" },
    ]);
  });

  // A colisão que o 23505 da #715 barrou: LLM viva presa em rodada anterior ao
  // lado de uma da rodada corrente. O índice LLM não tem round_id. (A órfã sem
  // par na corrente, o resíduo medido na #715, não colide com nada aqui e é
  // achado de `response-is-latest-na-rodada-corrente`.)
  it("acusa duas LLM vivas no mesmo doc em rodadas diferentes", () => {
    expect(
      violationDetails([llm("l-velha", { round_id: "rodada-1" }), llm("l-nova", { round_id: "rodada-2" })]),
    ).toEqual(["2 responses is_latest: l-velha, l-nova"]);
  });

  it("acusa duas LLM vivas sem respondent_name no mesmo doc", () => {
    expect(
      violationDetails([llm("l-a", { respondent_name: null }), llm("l-b", { respondent_name: null })]),
    ).toEqual(["2 responses is_latest: l-a, l-b"]);
  });

  // Chave de responses_one_latest_human_per_document:
  // (project_id, round_id, document_id, respondent_id).
  it("acusa duas humanas vivas do mesmo pesquisador no mesmo doc e rodada", () => {
    const violations = latestResponseUniquenessViolations([row({ id: "h-1" }), row({ id: "h-2" })]);
    expect(violations).toEqual([
      { key: "humano|proj|rodada-2|doc|ana", detail: "2 responses is_latest: h-1, h-2" },
    ]);
  });

  // Humana viva em rodada anterior é permitida pelo índice humano; quem a
  // acusa é `response-is-latest-na-rodada-corrente`. Repetir aqui contaria o
  // mesmo achado duas vezes e misturaria duas invariantes numa.
  it("não acusa humanas do mesmo pesquisador em rodadas diferentes", () => {
    expect(violationDetails([row({ id: "h-velha", round_id: "rodada-1" }), row({ id: "h-nova" })])).toEqual([]);
  });

  // O CHECK responses_human_latest_has_actor_check proíbe este estado; se ele
  // passar, o índice não o vê como colisão (NULLS DISTINCT) e a invariante,
  // que o espelha, também não.
  it("não agrupa humanas vivas sem respondent_id, como o índice", () => {
    expect(
      violationDetails([row({ id: "h-a", respondent_id: null }), row({ id: "h-b", respondent_id: null })]),
    ).toEqual([]);
  });

  it("não confunde humana e LLM no mesmo doc", () => {
    expect(violationDetails([row({ id: "h" }), llm("l")])).toEqual([]);
  });
});
