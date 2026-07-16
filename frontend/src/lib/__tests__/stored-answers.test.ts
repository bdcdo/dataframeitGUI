import { describe, it, expect } from "vitest";
import { sanitizeStoredAnswers } from "@/lib/stored-answers";
import type { PydanticField } from "@/lib/types";

const field = (f: Partial<PydanticField> & { name: string }): PydanticField =>
  ({ type: "text", ...f }) as PydanticField;

describe("sanitizeStoredAnswers", () => {
  it("mantém valor que ainda pertence às opções atuais", () => {
    const fields = [field({ name: "q", type: "single", options: ["x", "y"] })];
    expect(sanitizeStoredAnswers(fields, { q: "x" })).toEqual({ q: "x" });
  });

  // O descarte que produziu a #484: o valor não chega ao formulário, e por isso
  // o submit não o devolve — daí o saveResponse precisar remesclar o armazenado.
  it("descarta single fora das opções atuais", () => {
    const fields = [field({ name: "q", type: "single", options: ["x", "y"] })];
    expect(sanitizeStoredAnswers(fields, { q: "A" })).toEqual({});
  });

  it("filtra multi membro a membro e omite a chave quando esvazia", () => {
    const fields = [field({ name: "q", type: "multi", options: ["x", "y"] })];
    expect(sanitizeStoredAnswers(fields, { q: ["x", "z"] })).toEqual({ q: ["x"] });
    expect(sanitizeStoredAnswers(fields, { q: ["z"] })).toEqual({});
    expect(sanitizeStoredAnswers(fields, { q: [] })).toEqual({});
  });

  it("campo sem opções passa cru", () => {
    const fields = [field({ name: "t" }), field({ name: "d", type: "date" })];
    expect(sanitizeStoredAnswers(fields, { t: "livre", d: "2021-05-10" })).toEqual({
      t: "livre",
      d: "2021-05-10",
    });
  });

  it("não semeia campo llm_only nem none — não há widget para eles", () => {
    const fields = [
      field({ name: "humano" }),
      field({ name: "so_llm", target: "llm_only" }),
      field({ name: "nenhum", target: "none" }),
    ];
    expect(sanitizeStoredAnswers(fields, { humano: "a", so_llm: "b", nenhum: "c" })).toEqual({
      humano: "a",
    });
  });

  it("omite null/undefined e campo que saiu do schema", () => {
    const fields = [field({ name: "q" })];
    expect(sanitizeStoredAnswers(fields, { q: null, sumiu: "x" })).toEqual({});
  });

  it("remove condicional órfã, avaliando sobre o conjunto completo de campos (#252)", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["sim", "nao"] }),
      field({ name: "detalhe", condition: { field: "gatilho", equals: "sim" } }),
    ];
    // O gatilho foi para "nao": o filho não deve reaparecer pré-preenchido.
    expect(sanitizeStoredAnswers(fields, { gatilho: "nao", detalhe: "texto" })).toEqual({
      gatilho: "nao",
    });
  });

  it("condicional cujo gatilho saiu das opções some junto — o pai é descartado antes", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["X"] }),
      field({ name: "detalhe", condition: { field: "gatilho", equals: "X" } }),
    ];
    // "sim" não é mais opção → gatilho descartado → detalhe fica órfão.
    expect(sanitizeStoredAnswers(fields, { gatilho: "sim", detalhe: "texto" })).toEqual({});
  });

  it("sem respostas armazenadas, devolve {}", () => {
    expect(sanitizeStoredAnswers([field({ name: "q" })], null)).toEqual({});
    expect(sanitizeStoredAnswers([field({ name: "q" })], undefined)).toEqual({});
  });

  // Decisão consciente da extração: antes, as duas fronteiras faziam o OPOSTO
  // uma da outra aqui — Explorar passava tudo, Atribuídos apagava tudo.
  it("schema ausente/vazio devolve as respostas cruas, não {}", () => {
    expect(sanitizeStoredAnswers([], { q: "x" })).toEqual({ q: "x" });
  });

  it("não muta a entrada", () => {
    const fields = [field({ name: "q", type: "multi", options: ["x"] })];
    const answers = { q: ["x", "z"] };
    sanitizeStoredAnswers(fields, answers);
    expect(answers).toEqual({ q: ["x", "z"] });
  });
});
