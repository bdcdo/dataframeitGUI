// @vitest-environment jsdom
//
// O par "=" que a Comparação usa para fundir cards passa pela mesma regra de
// `filterCurrentEquivalencePairs`: valores iguais aos do momento da marcação E
// respostas dadas à versão atual da pergunta.
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useCompareFieldData } from "../useCompareFieldData";
import type { CompareResponse, EquivalencePairWire } from "../compare-types";
import type { PydanticField } from "@/lib/types";

afterEach(cleanup);

const HASH = "aaaaaaaaaaaa";
const OLD_HASH = "ffffffffffff";

const field: PydanticField = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "q",
  type: "text",
  options: null,
  description: "Pergunta",
  target: "all",
  hash: HASH,
};

function response(id: string, answer: string, hash: string): CompareResponse {
  return {
    id,
    respondent_type: "humano",
    respondent_name: id,
    respondent_id: id,
    answers: { q: answer },
    justifications: null,
    is_latest: true,
    is_partial: false,
    pydantic_hash: null,
    answer_field_hashes: { q: hash },
    schema_version_major: 1,
    schema_version_minor: 0,
    schema_version_patch: 0,
    created_at: "2026-01-01T00:00:00Z",
  };
}

const pair: EquivalencePairWire = {
  id: "eq1",
  response_a_id: "r1",
  response_b_id: "r2",
  reviewer_id: null,
  response_a_answer_snapshot: "alpha",
  response_b_answer_snapshot: "beta",
};

function render(hashB: string) {
  return renderHook(() =>
    useCompareFieldData({
      currentDoc: { id: "doc1", title: "Doc", external_id: null, text: "" } as never,
      currentFieldName: "q",
      currentField: field,
      responses: { doc1: [response("r1", "alpha", HASH), response("r2", "beta", hashB)] },
      fields: [field],
      projectPydanticHash: null,
      equivalencesByDocField: { doc1: { q: [pair] } },
    }),
  ).result.current;
}

describe("useCompareFieldData: par = e versão da pergunta", () => {
  it("funde os cards quando as duas respostas são da pergunta atual", () => {
    const data = render(HASH);
    expect(data.currentFieldEquivalences).toEqual([pair]);
    expect(data.answerGroups).toHaveLength(1);
  });

  it("não funde quando uma das respostas é de outra versão da pergunta", () => {
    const data = render(OLD_HASH);
    expect(data.currentFieldEquivalences).toEqual([]);
    expect(data.answerGroups).toHaveLength(2);
  });
});
