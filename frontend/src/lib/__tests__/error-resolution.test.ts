import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blankAnswerFor, choosesValue, decisionDependsOnSource, effectiveErrorResolution, errorDecisionSchema, errorResolutionComment, hasResolutionValue, isBlankAnswer,
  prefillLosesItems, prefillFromValue, prefillFromVerdict, startsBlank,
  type ErrorDecision, type ErrorResolutionRow, type ErrorResolutionContext,
} from "@/lib/error-resolution";
import { fieldHashOf } from "@/lib/schema-utils";
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

// Os mesmos casos de llm_error_decision_follows_field_hash.test.sql, a cópia
// SQL da regra.
describe("a decisão segue o hash do campo, não a definição inteira", () => {
  const question = { name: "q", type: "single" as const, options: ["A", "B"], description: "Pergunta", help_text: "Ajuda" };
  // A resposta do LLM é uma das opções, para que só a regra do hash decida.
  function withDefinitions(saved: Record<string, unknown>, current: Record<string, unknown>): ErrorResolutionRow {
    const r = row("llm_correct");
    r.context!.llm_value.value = "A";
    r.context!.field_definition = saved as ErrorResolutionContext["field_definition"];
    r.current_context = structuredClone(r.context);
    r.current_context!.field_definition = current as ErrorResolutionContext["field_definition"];
    return r;
  }
  const stamped = { ...question, hash: "h1" };

  it.each([
    ["help_text que só esclarece", { help_text: "Ajuda reescrita" }],
    ["condição nova", { condition: { field: "g0", equals: "Sim" } }],
    ["required", { required: true }],
    ["justification_prompt", { justification_prompt: "Por quê?" }],
  ])("%s com o mesmo hash mantém a decisão", (_label, patch) => {
    expect(effectiveErrorResolution(withDefinitions(stamped, { ...stamped, ...patch })).status).toBe("approved");
  });

  it.each([
    ["descrição nova", { description: "Outra pergunta", hash: "h2" }],
    ["opções novas", { options: ["A", "B", "C"], hash: "h3" }],
    ["revisão da question", { question_revision: 1, hash: "h4" }],
  ])("%s, que muda o hash, derruba a decisão", (_label, patch) => {
    expect(effectiveErrorResolution(withDefinitions(stamped, { ...stamped, ...patch }))).toEqual({ status: "stale" });
  });

  it("o hash carimbado vence o derivado: hashes diferentes derrubam mesmo com as partes iguais", () => {
    expect(effectiveErrorResolution(withDefinitions(stamped, { ...question, hash: "outra-formula" }))).toEqual({ status: "stale" });
  });

  it("o resto do contexto continua valendo inteiro", () => {
    const r = withDefinitions(stamped, { ...stamped, help_text: "Ajuda reescrita" });
    r.current_context!.human_value.value = "alterado";
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
  });

  it("definição gravada antes do carimbo tem o hash derivado pela mesma fórmula", () => {
    const hash = fieldHashOf(question);
    expect(effectiveErrorResolution(withDefinitions(question, { ...question, help_text: "Ajuda reescrita", hash })).status).toBe("approved");
    expect(effectiveErrorResolution(withDefinitions(question, { ...question, help_text: "Ajuda reescrita" })).status).toBe("approved");
    expect(effectiveErrorResolution(withDefinitions(question, { ...question, description: "Outra pergunta", hash: "h2" }))).toEqual({ status: "stale" });
  });

  it("o contador de revisão entra no hash derivado", () => {
    expect(effectiveErrorResolution(withDefinitions(question, { ...question, question_revision: 1 }))).toEqual({ status: "stale" });
  });

  it("definição sem as partes da fórmula cai para a comparação da definição inteira", () => {
    const withoutDescription = { name: "q", type: "single", options: ["A", "B"], help_text: "Ajuda" };
    expect(effectiveErrorResolution(withDefinitions(withoutDescription, { ...withoutDescription })).status).toBe("approved");
    expect(effectiveErrorResolution(withDefinitions(withoutDescription, { ...withoutDescription, help_text: "Ajuda reescrita" }))).toEqual({ status: "stale" });
  });
});

// O hash não cobre `condition`, `allow_other` nem `subfields`: a decisão
// sobrevive à mudança deles, e o valor que ela põe no gabarito é julgado pela
// definição atual.
describe("o valor aprovado é julgado pela definição atual", () => {
  const hash = "abcdefabcdef";
  const condition = { field: "g0", equals: "Sim" };
  function decided(
    decision: ErrorDecision, saved: Record<string, unknown>, current: Record<string, unknown>,
    patch: Partial<ErrorResolutionRow> = {},
  ): ErrorResolutionRow {
    const r = { ...row(decision), ...patch };
    r.context!.field_definition = { name: "q", description: "Pergunta", hash, ...saved } as ErrorResolutionContext["field_definition"];
    r.current_context = structuredClone(r.context);
    r.current_context!.field_definition = { name: "q", description: "Pergunta", hash, ...current } as ErrorResolutionContext["field_definition"];
    return r;
  }

  describe("o branco de condicional cai com a condição", () => {
    const text = { type: "text", options: null };
    it("Erro humano sobre o LLM sem a chave", () => {
      const absent = (saved: Record<string, unknown>, current: Record<string, unknown>) => {
        const r = decided("llm_correct", saved, current);
        r.context!.llm_value = { present: false, value: null };
        r.current_context!.llm_value = { present: false, value: null };
        return r;
      };
      expect(effectiveErrorResolution(absent({ ...text, condition }, { ...text, condition })))
        .toEqual({ status: "approved", value: "", isLlmError: false });
      expect(effectiveErrorResolution(absent({ ...text, condition }, text))).toEqual({ status: "stale" });
    });
    it("Erro humano sobre o LLM que respondeu o branco", () => {
      const blankLlm = (saved: Record<string, unknown>, current: Record<string, unknown>) => {
        const r = decided("llm_correct", saved, current);
        r.context!.llm_value.value = "";
        r.current_context!.llm_value.value = "";
        return r;
      };
      expect(effectiveErrorResolution(blankLlm({ ...text, condition }, { ...text, condition })).status).toBe("approved");
      expect(effectiveErrorResolution(blankLlm({ ...text, condition }, text))).toEqual({ status: "stale" });
      // Pergunta que nunca foi condicional: fora da regra, como antes.
      expect(effectiveErrorResolution(blankLlm(text, text)).status).toBe("approved");
    });
    it.each([
      ["Erro do LLM", "researchers_correct", { type: "text", options: null }, ""],
      ["Todos errados", "all_wrong", { type: "text", options: null }, ""],
      ["Ambos corretos", "both_correct", { type: "multi", options: ["A", "B"] }, []],
    ] as const)("%s com o branco canônico", (_label, decision, field, blank) => {
      expect(effectiveErrorResolution(decided(decision, { ...field, condition }, { ...field, condition }, { approved_value: blank })).status)
        .toBe("approved");
      expect(effectiveErrorResolution(decided(decision, { ...field, condition }, field, { approved_value: blank })))
        .toEqual({ status: "stale" });
    });
  });

  describe("fora do domínio atual, pela régua do veredito", () => {
    const single = { type: "single", options: ["A", "B"] };
    it.each([
      ["Erro do LLM", "researchers_correct"],
      ["Todos errados", "all_wrong"],
      ["Ambos corretos", "both_correct"],
    ] as const)("%s com Outro depois que allow_other é desligado", (_label, decision) => {
      const patch = { approved_value: "Outro: C" };
      expect(effectiveErrorResolution(decided(decision, { ...single, allow_other: true }, { ...single, allow_other: true }, patch)).status)
        .toBe("approved");
      expect(effectiveErrorResolution(decided(decision, { ...single, allow_other: true }, { ...single, allow_other: false }, patch)))
        .toEqual({ status: "stale" });
    });
    it("Erro humano com a resposta do LLM fora do domínio", () => {
      const llm = (value: string | string[], field: Record<string, unknown>) => {
        const r = decided("llm_correct", { ...field, allow_other: true }, field);
        r.context!.llm_value.value = value;
        r.current_context!.llm_value.value = value;
        return r;
      };
      expect(effectiveErrorResolution(llm("Outro: C", { ...single, allow_other: true })).status).toBe("approved");
      expect(effectiveErrorResolution(llm("Outro: C", single))).toEqual({ status: "stale" });
      const multi = { type: "multi", options: ["A", "B"] };
      expect(effectiveErrorResolution(llm(["A", "Outro: C"], { ...multi, allow_other: true })).status).toBe("approved");
      expect(effectiveErrorResolution(llm(["A", "Outro: C"], multi))).toEqual({ status: "stale" });
      expect(effectiveErrorResolution(llm(["A", "B"], multi)).status).toBe("approved");
    });
  });

  // `verdictInDomain` não mede registro de subcampos: o subcampo removido não
  // derruba a decisão, como não derruba o veredito da Comparação.
  it("subcampo removido com valor no registro não derruba a decisão", () => {
    const subfields = [{ key: "a", label: "A" }, { key: "b", label: "B" }];
    const r = decided("researchers_correct",
      { type: "text", options: null, subfields }, { type: "text", options: null, subfields: subfields.slice(0, 1) },
      { approved_value: { a: "x", b: "y" } });
    expect(effectiveErrorResolution(r)).toEqual({ status: "approved", value: { a: "x", b: "y" }, isLlmError: true });
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
  // #758: o veredito ficou para trás e os pesquisadores concordam com o LLM.
  // O valor comum vai ao gabarito, e nenhum dos lados conta erro.
  it("ambos corretos com o valor comum aprova esse valor, sem erro de ninguém", () => {
    expect(effectiveErrorResolution({ ...row("both_correct"), approved_value: "máquina" }))
      .toEqual({ status: "approved", value: "máquina", isLlmError: false });
  });
  it("o branco comum de condicional aprova o vazio mesmo com o LLM sem a chave", () => {
    const r = { ...row("both_correct"), approved_value: "" };
    r.context!.llm_value = { present: false, value: null };
    r.current_context = structuredClone(r.context);
    expect(effectiveErrorResolution(r)).toEqual({ status: "approved", value: "", isLlmError: false });
  });
  it("ambos corretos com valor também cai quando as respostas mudam", () => {
    const r = { ...row("both_correct"), approved_value: "máquina" };
    r.current_context!.llm_value.value = "outra";
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

const single: PydanticField = { id: "00000000-0000-4000-8000-000000000001", name: "s", type: "single", options: ["A", "B "], description: "" };
const singleOther: PydanticField = { ...single, allow_other: true };
const multi: PydanticField = { id: "00000000-0000-4000-8000-000000000002", name: "m", type: "multi", options: ["A", "B", "C"], description: "" };
const multiOther: PydanticField = { ...multi, allow_other: true };
const text: PydanticField = { id: "00000000-0000-4000-8000-000000000003", name: "t", type: "text", options: null, description: "" };
const group: PydanticField = { ...text, id: "00000000-0000-4000-8000-000000000004", name: "g", subfields: [{ key: "anos", label: "Anos" }] };

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
    [condMulti, [], true], [condMulti, "", false], [condMulti, ["A"], true], [condMulti, ["Z"], false], [condMulti, [""], false],
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

// set_error_resolution decide "LLM em branco" com uma classe de caracteres
// escrita à mão, porque btrim e [[:space:]] não batem com o trim() do JS. A
// classe precisa ser o conjunto que o trim() remove, que é o que
// isBlankAnswer usa no Gabarito e na métrica; a suíte SQL prende só alguns
// membros, e este teste prende a classe inteira.
describe("classe de branco de set_error_resolution", () => {
  it("é exatamente o conjunto que trim() remove", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations",
      "20260924120000_error_resolutions_resposta_em_branco.sql"), "utf8");
    const body = /~ E'\^\[(.*?)\]\*\$'/.exec(sql)?.[1];
    expect(body).toBeDefined();
    const escapes: Record<string, string> = { t: "\t", n: "\n", f: "\f", r: "\r" };
    const tokens = [...body!.matchAll(/\\u([0-9A-Fa-f]{4})|\\([tnfr])|([^\\])/g)].map(([, hex, esc, literal]) =>
      hex ? parseInt(hex, 16) : (esc ? escapes[esc] : literal).charCodeAt(0));
    const inClass = new Set<number>();
    for (let i = 0; i < tokens.length; i++) {
      // "a-b" é intervalo; o "-" chega como o código 0x2d.
      if (tokens[i + 1] === 0x2d && i + 2 < tokens.length) {
        for (let c = tokens[i]; c <= tokens[i + 2]; c++) inClass.add(c);
        i += 2;
      } else inClass.add(tokens[i]);
    }
    const trimmed: number[] = [];
    for (let c = 0; c <= 0xffff; c++) if (String.fromCharCode(c).trim() === "") trimmed.push(c);
    expect([...inClass].sort((a, b) => a - b)).toEqual(trimmed);
  });
});

describe("decisionDependsOnSource: decisão que depende do veredito de origem (#758)", () => {
  it.each<[ErrorDecision, boolean]>([
    ["llm_correct", false],
    ["researchers_correct", false],
    ["all_wrong", false],
    ["both_correct", true],
    ["discussion", true],
  ])("%s depende da fonte: %s", (decision, depends) => {
    expect(decisionDependsOnSource({ decision, approved_value: null })).toBe(depends);
  });

  it("decisão sem tipo (legado) nasce dependendo da fonte", () => {
    expect(decisionDependsOnSource({ decision: null, approved_value: null })).toBe(true);
  });

  // #758: com o valor comum, "Ambos corretos" é um julgamento novo sobre as
  // respostas atuais, como as demais decisões com valor.
  it("ambos corretos com o valor comum não depende da fonte", () => {
    const row = { decision: "both_correct" as const, approved_value: "LLM" };
    expect(decisionDependsOnSource(row)).toBe(false);
    // O branco comum também é valor próprio: "" não é ausência de valor.
    expect(decisionDependsOnSource({ ...row, approved_value: "" })).toBe(false);
    expect(decisionDependsOnSource({ ...row, approved_value: [] })).toBe(false);
  });
});
