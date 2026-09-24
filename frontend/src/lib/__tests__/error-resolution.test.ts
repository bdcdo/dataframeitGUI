import { describe, expect, it } from "vitest";
import {
  blankAnswerFor, choosesValue, effectiveErrorResolution, errorDecisionSchema, errorResolutionComment, hasResolutionValue, isBlankAnswer,
  prefillLosesItems, prefillFromValue, prefillFromVerdict, startsBlank,
  type ErrorResolutionRow, type ErrorResolutionContext,
} from "@/lib/error-resolution";
import type { PydanticField } from "@/lib/types";

const context: ErrorResolutionContext = {
  project_id: "p", document_id: "d", field_name: "q", round_id: "round",
  automation_mode: "compare_llm", field_definition: { name: "q", type: "text" },
  llm_response_id: "llm", human_response_id: "human",
  llm_value: { present: true, value: "máquina" },
  human_value: { present: true, value: "humano" },
  source: { kind: "comparacao", id: "review", verdict: "humano" },
};
function row(decision: ErrorResolutionRow["decision"]): ErrorResolutionRow {
  return { id: "resolution", project_id: "p", document_id: "d", field_name: "q",
    resolved_at: "2026-09-14T12:00:00Z", resolved_by: "user", note: null,
    decision, context: structuredClone(context), current_context: structuredClone(context),
    approved_value: decision === "researchers_correct" ? "humano" : decision === "all_wrong" ? "terceira" : null };
}

describe("resolução explícita de divergência", () => {
  it("aprova o valor LLM sem interpretar texto formatado", () => {
    expect(effectiveErrorResolution(row("llm_correct"))).toMatchObject({ status: "approved", value: "máquina", isLlmError: false });
  });
  it("confirmar humanos continua sendo erro do LLM", () => {
    expect(effectiveErrorResolution(row("researchers_correct"))).toMatchObject({ status: "approved", value: "humano", isLlmError: true });
  });
  it("discussão bloqueia aprovação, em vez de representar ausência de decisão", () => {
    expect(effectiveErrorResolution(row("discussion"))).toEqual({ status: "discussion" });
  });
  it("legado não inventa vencedor e ausência de registro não é legado", () => {
    expect(effectiveErrorResolution({ ...row(null), context: null, current_context: null })).toEqual({ status: "legacy" });
    expect(effectiveErrorResolution(undefined)).toEqual({ status: "open" });
  });
  it.each([null, "", false, 0, [], ["a", "b"]])("preserva o valor tipado %j", (value) => {
    const r = row("llm_correct");
    r.context!.llm_value.value = value;
    r.current_context = structuredClone(r.context);
    expect(effectiveErrorResolution(r)).toMatchObject({ status: "approved", value });
  });
  it("ausência de chave não é valor null aprovado", () => {
    const r = row("llm_correct");
    r.context!.llm_value = { present: false, value: null };
    r.current_context = structuredClone(r.context);
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
  });
  it("ignora ordem de chaves de JSONB, mas não alteração de valor", () => {
    const r = row("llm_correct");
    r.current_context!.source = { verdict: "humano", id: "review", kind: "comparacao" };
    expect(effectiveErrorResolution(r).status).toBe("approved");
    r.current_context!.human_value.value = "alterado";
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
  });
  it.each(["round_id", "llm_response_id", "human_response_id"] as const)("recusa contexto alterado em %s", (key) => {
    const r = row("discussion");
    r.current_context![key] = "novo";
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
  });
  it("fonte removida, campo alterado ou review editado invalida a resolução", () => {
    const r = row("llm_correct");
    expect(effectiveErrorResolution({ ...r, current_context: null })).toEqual({ status: "stale" });
    r.current_context!.field_definition = { name: "q", type: "single" };
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
    r.current_context = structuredClone(r.context);
    r.current_context!.source.verdict = "outro";
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
  });
});

describe("Erro do LLM leva o valor escolhido, não a resposta do codificador (#733)", () => {
  it("aprova approved_value mesmo quando a resposta humana do contexto é outra", () => {
    const r = row("researchers_correct");
    r.context!.human_value.value = "codificador";
    r.current_context = structuredClone(r.context);
    expect(effectiveErrorResolution(r)).toMatchObject({ status: "approved", value: "humano", isLlmError: true });
  });
  it("resposta humana sem o campo não invalida: ela é só âncora do contexto", () => {
    const r = row("researchers_correct");
    r.context!.human_value = { present: false, value: null };
    r.current_context = structuredClone(r.context);
    expect(effectiveErrorResolution(r).status).toBe("approved");
  });
  it("linha anterior à coluna pede confirmação de novo em vez de inventar valor", () => {
    expect(effectiveErrorResolution({ ...row("researchers_correct"), approved_value: null })).toEqual({ status: "stale" });
    expect(effectiveErrorResolution({ ...row("researchers_correct"), approved_value: undefined })).toEqual({ status: "stale" });
  });
  it.each([["a", "b"], { anos: "2" }, 0, false])("preserva o valor tipado %j de approved_value", (value) => {
    expect(effectiveErrorResolution({ ...row("researchers_correct"), approved_value: value })).toMatchObject({ status: "approved", value });
  });
});

describe("Ambos corretos e Todos errados", () => {
  it("ambos corretos não aprova valor: mantém o veredito e guarda a resposta do LLM", () => {
    const result = effectiveErrorResolution(row("both_correct"));
    expect(result).toEqual({ status: "upheld", llmValue: "máquina" });
    expect(result).not.toHaveProperty("value");
  });
  it("ambos corretos exige a resposta do LLM que declara correta", () => {
    const r = row("both_correct");
    r.context!.llm_value = { present: false, value: null };
    r.current_context = structuredClone(r.context);
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
  });
  it("todos errados aprova o valor escolhido, que não é o do LLM nem o humano, e segue erro do LLM", () => {
    expect(effectiveErrorResolution(row("all_wrong"))).toEqual({ status: "approved", value: "terceira", isLlmError: true });
  });
  it("todos errados sem valor pede confirmação de novo", () => {
    expect(effectiveErrorResolution({ ...row("all_wrong"), approved_value: null })).toEqual({ status: "stale" });
  });
  it("fonte alterada invalida as duas decisões novas", () => {
    for (const decision of ["both_correct", "all_wrong"] as const) {
      const r = row(decision);
      r.current_context!.llm_value.value = "outra";
      expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
    }
  });
  it("choosesValue separa as decisões com seletor das demais, sem deixar nenhuma de fora", () => {
    expect(errorDecisionSchema.options.filter(choosesValue)).toEqual(["researchers_correct", "all_wrong"]);
  });
  it("as duas decisões entram no comentário de export com o rótulo próprio", () => {
    expect(errorResolutionComment({ ...row("both_correct"), note: "sinônimos" })).toBe("[q] Ambos corretos: sinônimos");
    expect(errorResolutionComment(row("all_wrong"))).toBe("[q] Todos errados");
  });
});

const single: PydanticField = { name: "s", type: "single", options: ["A", "B "], description: "" };
const singleOther: PydanticField = { ...single, allow_other: true };
const multi: PydanticField = { name: "m", type: "multi", options: ["A", "B", "C"], description: "" };
const multiOther: PydanticField = { ...multi, allow_other: true };
const text: PydanticField = { name: "t", type: "text", options: null, description: "" };
const group: PydanticField = { ...text, name: "g", subfields: [{ key: "anos", label: "Anos" }] };

describe("prefillFromVerdict — o veredito anterior nas opções atuais", () => {
  it("single: casa por trim; opção que saiu do formulário não pré-marca", () => {
    expect(prefillFromVerdict(single, "B")).toBe("B ");
    expect(prefillFromVerdict(single, " A ")).toBe("A");
    expect(prefillFromVerdict(single, "C")).toBeUndefined();
  });
  it("multi: chaves true do JSON do veredito que ainda são opções, como array", () => {
    expect(prefillFromVerdict(multi, '{"C":true,"A":true,"B":false}')).toEqual(["A", "C"]);
    expect(prefillFromVerdict(multi, '{"Z":true}')).toBeUndefined();
    expect(prefillFromVerdict(multi, "não é json")).toBeUndefined();
  });
  it("texto e data: o próprio veredito; vazio não pré-preenche", () => {
    expect(prefillFromVerdict(text, "livre")).toBe("livre");
    expect(prefillFromVerdict(text, "  ")).toBeUndefined();
    expect(prefillFromVerdict({ ...text, type: "date" }, "01/02/2026")).toBe("01/02/2026");
  });
  it("subcampos: o veredito é texto renderizado; só a sentinela é reconhecível", () => {
    expect(prefillFromVerdict(group, "anos: 2")).toBeUndefined();
    expect(prefillFromVerdict(group, "Não informada")).toBe("Não informada");
  });
  it("os marcadores da Comparação nunca viram resposta", () => {
    expect(prefillFromVerdict(text, "ambiguo")).toBeUndefined();
    expect(prefillFromVerdict(single, "pular")).toBeUndefined();
    expect(prefillFromVerdict({ ...text, type: "date" }, "ambiguo")).toBeUndefined();
  });
});

describe("prefillFromValue — valor já na forma da resposta", () => {
  it("single e multi casam por trim contra as opções atuais", () => {
    expect(prefillFromValue(single, "B")).toBe("B ");
    expect(prefillFromValue(single, "C")).toBeUndefined();
    expect(prefillFromValue(single, ["A"])).toBeUndefined();
    expect(prefillFromValue(multi, ["C", "Z", "A"])).toEqual(["A", "C"]);
    expect(prefillFromValue(multi, "A, C")).toBeUndefined();
  });
  it("texto e grupo levam o valor quando ele tem a forma certa", () => {
    expect(prefillFromValue(text, "livre")).toBe("livre");
    expect(prefillFromValue(text, " ")).toBeUndefined();
    expect(prefillFromValue(group, { anos: "2" })).toEqual({ anos: "2" });
    expect(prefillFromValue(group, "anos: 2")).toBeUndefined();
  });
});

describe("prefillLosesItems — quando o seletor abre com menos do que a fonte marcava", () => {
  it("veredito JSON: acusa opção que saiu, ignora chave false e opção com espaço a mais", () => {
    expect(prefillLosesItems(multi, '{"A":true,"Z":true}')).toBe(true);
    expect(prefillLosesItems(multi, '{"A":true,"Z":false}')).toBe(false);
    expect(prefillLosesItems(multi, '{"A ":true,"C":true}')).toBe(false);
  });
  it("veredito em texto: mede pela forma crua, que é de onde o valor inicial vem", () => {
    expect(prefillLosesItems(multi, "A, Z", ["A", "Z"])).toBe(true);
    expect(prefillLosesItems(multi, "A, C", ["A", "C"])).toBe(false);
    expect(prefillLosesItems(multi, "A, C")).toBe(false);
  });
  it("Outro: cabe quando o campo permite, e só o primeiro entra no seletor", () => {
    expect(prefillLosesItems(multiOther, '{"A":true,"Outro: x":true}')).toBe(false);
    expect(prefillLosesItems(multi, '{"A":true,"Outro: x":true}')).toBe(true);
    expect(prefillFromValue(multiOther, ["Outro: x", "A", "Outro: y"])).toEqual(["A", "Outro: x"]);
    expect(prefillLosesItems(multiOther, "", ["Outro: x", "A", "Outro: y"])).toBe(true);
  });
  it("não se aplica fora de multi", () => {
    expect(prefillLosesItems(single, "Z")).toBe(false);
  });
});

describe("hasResolutionValue — o que basta para confirmar", () => {
  it.each<[PydanticField, unknown, boolean]>([
    [single, "A", true], [single, "", false], [single, undefined, false], [single, "Z", false],
    [single, "Outro: x", false], [singleOther, "Outro: x", true], [singleOther, "Outro: ", false], [singleOther, "Outro:  ", false],
    [multi, ["A"], true], [multi, [], false], [multi, ["Z"], false], [multi, "A", false],
    [multiOther, ["A", "Outro: y"], true], [multiOther, ["Outro: "], false],
    [group, { anos: "2" }, true], [group, { anos: "" }, false], [group, {}, false], [group, "Não informada", true],
    [group, { desconhecido: "x" }, false], [group, { anos: 5 }, false],
    [text, "x", true], [text, " ", false],
    [{ ...text, type: "date" }, "01/02/2026", true], [{ ...text, type: "date" }, "XX/03/2024", true],
    [{ ...text, type: "date" }, "ambiguo", false], [{ ...text, type: "date" }, "32/01/2026", false],
    [{ ...text, type: "date" }, "Não informada", true], [{ ...text, type: "date", options: ["Sem data"] }, "Sem data", true],
  ])("%s com %j → %s", (field, value, expected) => {
    expect(hasResolutionValue(field, value)).toBe(expected);
  });
});

describe("resposta em branco em pergunta condicional", () => {
  const condition = { field: "g0", equals: "Sim" };
  const condSingle: PydanticField = { ...single, condition };
  const condMulti: PydanticField = { ...multi, condition };
  const condText: PydanticField = { ...text, condition };
  const condDate: PydanticField = { ...text, type: "date", condition };
  const condGroup: PydanticField = { ...group, condition };

  it.each<[PydanticField, unknown, boolean]>([
    [condSingle, "", true], [condSingle, " ", false], [condSingle, [], false], [condSingle, null, false], [condSingle, undefined, false],
    [condMulti, [], true], [condMulti, "", false],
    [condText, "", true], [condDate, "", true], [condGroup, "", true],
    [single, "", false], [multi, [], false], [text, "", false],
  ])("hasResolutionValue(%s, %j) → %s: o vazio canônico só vale em condicional", (field, value, expected) => {
    expect(hasResolutionValue(field, value)).toBe(expected);
  });

  it("o vazio canônico é [] em multi e \"\" nos demais tipos", () => {
    expect(blankAnswerFor(condMulti)).toEqual([]);
    expect(blankAnswerFor(condSingle)).toBe("");
    expect(blankAnswerFor(condGroup)).toBe("");
  });

  it.each<[unknown, boolean]>([
    [undefined, true], [null, true], ["", true], ["  ", true], [[], true],
    ["A", false], [["A"], false], [{}, false], [0, false],
  ])("isBlankAnswer(%j) → %s", (value, expected) => {
    expect(isBlankAnswer(value)).toBe(expected);
  });

  function absentLlm(decision: ErrorResolutionRow["decision"], definition: Record<string, unknown>): ErrorResolutionRow {
    const base = row(decision);
    const ctx = { ...base.context!, field_definition: definition, llm_value: { present: false, value: null } } as ErrorResolutionContext;
    return { ...base, context: ctx, current_context: structuredClone(ctx) };
  }

  it("Erro humano com o LLM fora da condicional aprova o vazio do tipo", () => {
    expect(effectiveErrorResolution(absentLlm("llm_correct", { name: "q", type: "single", condition })))
      .toEqual({ status: "approved", value: "", isLlmError: false });
    expect(effectiveErrorResolution(absentLlm("llm_correct", { name: "q", type: "multi", condition })))
      .toEqual({ status: "approved", value: [], isLlmError: false });
  });

  it("sem condição, ou em Ambos corretos, a resposta ausente do LLM segue sem valor", () => {
    expect(effectiveErrorResolution(absentLlm("llm_correct", { name: "q", type: "single" })).status).toBe("stale");
    expect(effectiveErrorResolution(absentLlm("both_correct", { name: "q", type: "single", condition })).status).toBe("stale");
  });

  it("startsBlank: veredito vazio em condicional abre em branco no Erro do LLM", () => {
    expect(startsBlank(condSingle, "researchers_correct", "", undefined)).toBe(true);
    expect(startsBlank(condMulti, "researchers_correct", "{}", undefined)).toBe(true);
    expect(startsBlank(condMulti, "researchers_correct", "{\"A\":false}", undefined)).toBe(true);
    expect(startsBlank(condSingle, "researchers_correct", "A", undefined)).toBe(false);
    expect(startsBlank(condSingle, "researchers_correct", "ambiguo", undefined)).toBe(false);
    expect(startsBlank(single, "researchers_correct", "", undefined)).toBe(false);
  });

  it("startsBlank: Todos errados não parte do veredito, só da própria decisão anterior", () => {
    expect(startsBlank(condSingle, "all_wrong", "", undefined)).toBe(false);
    expect(startsBlank(condSingle, "all_wrong", "A", "")).toBe(true);
    expect(startsBlank(condSingle, "researchers_correct", "", "B ")).toBe(false);
  });
});
