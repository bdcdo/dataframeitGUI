// @vitest-environment jsdom
//
// A equivalência "=" de valor que a Comparação usa para fundir cards vale na
// versão da pergunta em que foi decidida (`field_hash` igual ao hash atual do
// campo) e só funde respostas dadas a essa versão. Não depende de qual
// resposta a originou: sobrevive a recodificação com o mesmo valor.
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useCompareFieldData } from "../useCompareFieldData";
import type { CompareResponse } from "../compare-types";
import type { ValueEquivalence } from "@/lib/equivalence";
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

const pair: ValueEquivalence = {
  id: "eq1",
  field_name: "q",
  field_hash: HASH,
  value_a: "alpha",
  value_b: "beta",
  reviewer_id: null,
};

function render(hashB: string, equivalences: ValueEquivalence[] = [pair], idB = "r2") {
  return renderHook(() =>
    useCompareFieldData({
      currentDoc: { id: "doc1", title: "Doc", external_id: null, text: "" } as never,
      currentFieldName: "q",
      currentField: field,
      responses: { doc1: [response("r1", "alpha", HASH), response(idB, "beta", hashB)] },
      fields: [field],
      projectPydanticHash: null,
      equivalencesByField: { q: equivalences },
    }),
  ).result.current;
}

describe("useCompareFieldData: equivalência de valor e versão da pergunta", () => {
  it("funde os cards quando as duas respostas são da pergunta atual", () => {
    const data = render(HASH);
    expect(data.currentFieldEquivalences).toEqual([pair]);
    expect(data.answerGroups).toHaveLength(1);
  });

  it("não funde quando uma das respostas é de outra versão da pergunta", () => {
    const data = render(OLD_HASH);
    // A equivalência continua valendo na versão atual; a resposta antiga é
    // que não entra na fusão.
    expect(data.currentFieldEquivalences).toEqual([pair]);
    expect(data.answerGroups).toHaveLength(2);
  });

  it("equivalência de outra versão da pergunta não vale nem funde", () => {
    const data = render(HASH, [{ ...pair, field_hash: OLD_HASH }]);
    expect(data.currentFieldEquivalences).toEqual([]);
    expect(data.answerGroups).toHaveLength(2);
  });

  it("sobrevive a outra resposta (recodificação ou LLM novo) com o mesmo valor", () => {
    const data = render(HASH, [pair], "r2-nova-execucao");
    expect(data.answerGroups).toHaveLength(1);
  });

  // O card usa esta marca para oferecer o "=" (a RPC recusa o par com resposta
  // de outra versão). Sem hash, a ausência não invalida.
  it("marca em cada resposta se ela foi dada à versão atual da pergunta", () => {
    const flags = (hash: string | null) =>
      renderHook(() =>
        useCompareFieldData({
          currentDoc: { id: "doc1", title: "Doc", external_id: null, text: "" } as never,
          currentFieldName: "q",
          currentField: field,
          responses: {
            doc1: [
              response("r1", "alpha", HASH),
              { ...response("r2", "beta", HASH), answer_field_hashes: hash === null ? {} : { q: hash } },
            ],
          },
          fields: [field],
          projectPydanticHash: null,
          equivalencesByField: {},
        }),
      ).result.current.fieldResponses.map((r) => r.answersCurrentQuestion);

    expect(flags(HASH)).toEqual([true, true]);
    expect(flags(OLD_HASH)).toEqual([true, false]);
    expect(flags(null)).toEqual([true, true]);
  });
});
