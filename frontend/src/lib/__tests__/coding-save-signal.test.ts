// Régua única de completude compartilhada entre a UI de codificação e o
// servidor: `missingRequiredHumanFields` decide tanto o que o botão "Enviar"
// exige quanto o `is_partial` gravado. Enquanto a regra vivia duplicada, "o que
// o botão exige" podia divergir de "o que o servidor considera concluído" sem
// nenhum gate reclamar (#519). O carimbo de proveniência em si (o mapa
// `answer_field_hashes`) é coberto por `response-snapshot.test.ts` (#520/#528);
// aqui fixamos só a régua que se apoia nele.
import { describe, it, expect } from "vitest";
import { missingRequiredHumanFields } from "@/lib/coding-completeness";
import type { PydanticField } from "@/lib/types";

const field = (partial: Partial<PydanticField> & { name: string }): PydanticField =>
  ({ type: "text", options: null, ...partial }) as PydanticField;

// Schema de 2 campos contra o qual a codificação foi feita.
const schemaAntigo = [
  field({ name: "q1", type: "single", options: ["a", "b"], hash: "h-q1" }),
  field({ name: "q2", hash: "h-q2" }),
];
// Campo obrigatório criado DEPOIS: o caso do `medicamento` no Zolgensma.
const schemaAtual = [...schemaAntigo, field({ name: "q3_novo", hash: "h-q3" })];

const codificacaoCompleta = { q1: "a", q2: "texto" };
const carimboDaEpoca = { q1: "h-q1", q2: "h-q2" };

describe("missingRequiredHumanFields — régua única de UI e servidor", () => {
  it("conta apenas obrigatórias visíveis para humano", () => {
    const fields = [
      field({ name: "obrigatoria" }),
      field({ name: "opcional", required: false }),
      field({ name: "so_llm", target: "llm_only" }),
      field({ name: "oculta", condition: { field: "obrigatoria", equals: "x" } }),
    ];
    expect(missingRequiredHumanFields(fields, {}).map((f) => f.name)).toEqual(["obrigatoria"]);
  });

  it("não cobra campo que ainda não existia quando a resposta foi codificada", () => {
    expect(missingRequiredHumanFields(schemaAtual, codificacaoCompleta, carimboDaEpoca)).toEqual([]);
    // Sem o carimbo (avaliação staleness-blind), o campo novo é cobrado.
    expect(
      missingRequiredHumanFields(schemaAtual, codificacaoCompleta).map((f) => f.name),
    ).toEqual(["q3_novo"]);
  });

  it("'Outro:' pela metade e multi vazio contam como faltantes", () => {
    const fields = [
      field({ name: "single", type: "single", options: ["a"], allow_other: true }),
      field({ name: "multi", type: "multi", options: ["a"] }),
    ];
    expect(
      missingRequiredHumanFields(fields, { single: "Outro: ", multi: [] }).map((f) => f.name),
    ).toEqual(["single", "multi"]);
    expect(missingRequiredHumanFields(fields, { single: "Outro: x", multi: ["a"] })).toEqual([]);
  });
});
