// A régua de `set_error_resolution` para o valor aprovado ("Erro do LLM",
// "Todos errados"), tipo a tipo, que a invariante
// `approved-value-no-dominio-atual` usa. Um caso aceito e um recusado por
// tipo, e o grupo de subcampos com texto solto, que a RPC aceita e a tela não.
import { describe, it, expect } from "vitest";
import { hasResolutionValue, rpcAcceptsResolutionValue, type ErrorResolutionContext } from "@/lib/error-resolution";
import { NOT_INFORMED } from "@/lib/sentinels";
import type { PydanticField } from "@/lib/types";

const base = { id: "00000000-0000-4000-8000-000000000001", name: "q", description: "P" };
const single = { ...base, type: "single", options: ["Sim", "Não"] } as PydanticField;
const singleOther = { ...single, allow_other: true } as PydanticField;
const multi = { ...base, type: "multi", options: ["A", "B"] } as PydanticField;
const multiOther = { ...multi, allow_other: true } as PydanticField;
const text = { ...base, type: "text", options: null } as PydanticField;
const date = { ...base, type: "date", options: ["Sem data"] } as PydanticField;
const group = { ...base, type: "text", options: null, subfields: [{ key: "anos", label: "Anos" }, { key: "meses", label: "Meses" }] } as PydanticField;
const conditionalText = { ...text, condition: { field: "outro", equals: "Sim" } } as PydanticField;
const conditionalMulti = { ...multi, condition: { field: "outro", equals: "Sim" } } as PydanticField;

type LlmValue = ErrorResolutionContext["llm_value"];
const llm = (value: LlmValue["value"], present = true): LlmValue => ({ present, value });
const LLM_ANSWERED = llm("resposta do LLM");

describe("rpcAcceptsResolutionValue: a régua de set_error_resolution", () => {
  it.each<[string, PydanticField, unknown, boolean, LlmValue?]>([
    ["single: opção atual", single, "Sim", true],
    ["single: fora das opções", single, "Talvez", false],
    ["single com allow_other: Outro com complemento", singleOther, "Outro: parcial", true],
    ["single com allow_other: Outro sem complemento", singleOther, "Outro:  ", false],
    ["multi: opções atuais", multi, ["A", "B"], true],
    ["multi: vazio", multi, [], false],
    ["multi com allow_other: Outro no array", multiOther, ["A", "Outro: x"], true],
    ["multi: opção extinta", multi, ["A", "C"], false],
    ["texto: não vazio", text, "qualquer", true],
    ["texto: só espaço", text, "   ", false],
    ["data: parcial", date, "XX/03/2020", true],
    ["data: sentinela do campo", date, "Sem data", true],
    ["data: sentinela geral", date, NOT_INFORMED, true],
    ["data: texto solto", date, "ambiguo", false],
    ["grupo: objeto com subcampo conhecido", group, { anos: "3" }, true],
    ["grupo: subcampo desconhecido", group, { dias: "3" }, false],
    ["grupo: objeto sem valor", group, { anos: " " }, false],
    // O último ELSIF da RPC aceita texto solto em grupo de subcampos.
    ["grupo: texto solto", group, "3 anos", true],
    ["grupo: texto solto com espaço final", group, "3 anos e 4 meses ", true],
    ["grupo: sentinela", group, NOT_INFORMED, true],
    ["grupo: texto vazio", group, "", false],
    ["grupo: array", group, ["3"], false],
    ["qualquer tipo: null", text, null, false],
    ["condicional: branco canônico com o LLM respondendo", conditionalText, "", true],
    ["condicional: branco com o LLM também em branco", conditionalText, "", false, llm(" ")],
    ["condicional: branco com o LLM sem a chave", conditionalText, "", false, llm(null, false)],
    ["condicional multi: [] com o LLM respondendo", conditionalMulti, [], true],
    ["não condicional: branco", text, "", false],
  ])("%s", (_label, field, value, expected, llmValue = LLM_ANSWERED) => {
    expect(rpcAcceptsResolutionValue({ field_definition: field, llm_value: llmValue }, value)).toBe(expected);
  });

  // A tela continua mais restritiva no grupo: o seletor só produz objeto ou a
  // sentinela.
  it("a tela recusa o texto solto em grupo que a RPC aceita", () => {
    expect(hasResolutionValue(group, "3 anos")).toBe(false);
    expect(rpcAcceptsResolutionValue({ field_definition: group, llm_value: LLM_ANSWERED }, "3 anos")).toBe(true);
  });
});
