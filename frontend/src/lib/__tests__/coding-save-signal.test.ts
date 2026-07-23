// Guards do sinal de submissão de uma codificação: o carimbo de proveniência
// (`answer_field_hashes`) e o `is_partial` derivado dele. Juntos, esses dois
// pontos decidem se um documento já codificado volta ou não para a fila — a
// família de bugs que o pesquisador lê como "minha codificação não salvou"
// (#519/#520).
import { describe, it, expect } from "vitest";
import { buildPersistedResponseSnapshot } from "@/lib/response-snapshot";
import { isCodingComplete, missingRequiredHumanFields } from "@/lib/coding-completeness";
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

describe("proveniência preservada mantém a codificação completa", () => {
  // O guard do carimbo em si vive no #528 (response-snapshot); aqui fixamos a
  // consequência da qual a régua desta issue depende: enquanto o mapa herdado
  // não afirmar que o campo novo já existia, a codificação antiga continua
  // completa e o documento não volta para a fila.
  it("auto-save de passagem não torna a codificação antiga incompleta", () => {
    const snapshot = buildPersistedResponseSnapshot({
      fields: schemaAtual,
      storedAnswers: codificacaoCompleta,
      storedHashes: carimboDaEpoca,
      isNewResponse: false,
      rawSubmittedAnswers: codificacaoCompleta,
    });

    expect(
      isCodingComplete(schemaAtual, snapshot.persistedAnswers, snapshot.answerFieldHashes),
    ).toBe(true);
  });

  it("primeira escrita cobra o schema inteiro — nada fica isento da régua", () => {
    const snapshot = buildPersistedResponseSnapshot({
      fields: schemaAtual,
      storedAnswers: null,
      storedHashes: undefined,
      isNewResponse: true,
      rawSubmittedAnswers: { q1: "a" },
    });

    expect(
      isCodingComplete(schemaAtual, snapshot.persistedAnswers, snapshot.answerFieldHashes),
    ).toBe(false);
  });
});

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
