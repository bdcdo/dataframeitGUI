import { describe, it, expect } from "vitest";
import { mergeSubmittedAnswers } from "@/lib/answer-merge";
import { dropHiddenConditionals } from "@/lib/conditional";
import { isCodingComplete } from "@/lib/coding-completeness";
import type { PydanticField } from "@/lib/types";

// Helper: monta um PydanticField com defaults mínimos.
const field = (f: Partial<PydanticField> & { name: string }): PydanticField =>
  ({ type: "text", ...f }) as PydanticField;

describe("mergeSubmittedAnswers", () => {
  it("preserva chave que a leitura descartou por estar fora das opções atuais (#484)", () => {
    // q_opt valia "A"; as opções viraram ["X","Y"], então o clean de leitura
    // não entrega q_opt ao formulário e o submit não a devolve.
    const stored = { q_opt: "A", q_txt: "antigo" };
    const submitted = { q_txt: "novo" };

    expect(mergeSubmittedAnswers(stored, submitted)).toEqual({
      q_opt: "A",
      q_txt: "novo",
    });
  });

  it("chave submetida vence, inclusive vazia — limpar um campo continua funcionando", () => {
    expect(mergeSubmittedAnswers({ q_txt: "antigo", q_multi: ["X"] }, { q_txt: "", q_multi: [] })).toEqual({
      q_txt: "",
      q_multi: [],
    });
  });

  it("sem resposta armazenada, devolve o submetido (primeira codificação)", () => {
    expect(mergeSubmittedAnswers(null, { q_txt: "primeiro" })).toEqual({ q_txt: "primeiro" });
    expect(mergeSubmittedAnswers(undefined, { q_txt: "primeiro" })).toEqual({ q_txt: "primeiro" });
  });

  it("não muta os objetos de entrada", () => {
    const stored = { q_opt: "A" };
    const submitted = { q_txt: "novo" };
    mergeSubmittedAnswers(stored, submitted);
    expect(stored).toEqual({ q_opt: "A" });
    expect(submitted).toEqual({ q_txt: "novo" });
  });
});

// Reproduz a composição exata do saveResponse: merge para persistir, e o
// conjunto submetido — sem merge — para decidir completude. É o contrato que
// impede a #484 de virar uma conclusão silenciosa.
describe("composição do saveResponse (#484)", () => {
  const fields = [
    field({ name: "q_opt", type: "single", options: ["X", "Y"], required: true }),
    field({ name: "q_txt", required: true }),
  ];

  it("persiste o valor stale sem deixá-lo concluir a codificação sozinho", () => {
    const stored = { q_opt: "A", q_txt: "antigo" };
    const submitted = { q_txt: "novo" };

    const sanitized = dropHiddenConditionals(fields, submitted);
    const persisted = dropHiddenConditionals(fields, mergeSubmittedAnswers(stored, sanitized));

    // O valor antigo sobrevive no banco...
    expect(persisted.q_opt).toBe("A");
    // ...mas q_opt segue pendente para o pesquisador, porque "A" não é uma
    // resposta ao formulário atual. Se a completude olhasse o conjunto
    // persistido, este documento fecharia sem ninguém ver o campo.
    expect(isCodingComplete(fields, sanitized)).toBe(false);
    expect(isCodingComplete(fields, persisted)).toBe(true);
  });

  it("condicional oculta continua sendo removida do conjunto persistido", () => {
    const condFields = [
      field({ name: "gatilho", type: "single", options: ["sim", "nao"] }),
      field({ name: "detalhe", condition: { field: "gatilho", equals: "sim" } }),
    ];
    // A resposta antiga tinha o filho preenchido; o pesquisador troca o gatilho
    // para "nao". O merge não pode ressuscitar o filho órfão.
    const stored = { gatilho: "sim", detalhe: "texto" };
    const submitted = { gatilho: "nao" };

    const sanitized = dropHiddenConditionals(condFields, submitted);
    const persisted = dropHiddenConditionals(condFields, mergeSubmittedAnswers(stored, sanitized));

    expect(persisted).toEqual({ gatilho: "nao" });
    expect("detalhe" in persisted).toBe(false);
  });
});
