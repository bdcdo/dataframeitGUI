// "Ambos corretos" grava o valor comum quando o veredito ficou para trás
// (#758). A regra vive em duas cópias: a TypeScript (`bothCorrectCommonValue`,
// em llm-error-metrics.ts, sobre as mesmas primitivas da métrica) e a SQL
// (`both_correct_common_value`, que o RPC usa para calcular e conferir o
// valor). Os cenários e a matriz das funções puras abaixo são os mesmos de
// supabase/tests/both_correct_common_value.test.sql, para que as duas cópias
// falhem juntas quando uma derivar.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  answersAgree,
  bothCorrectCommonValue,
  verdictMatchesAnswer,
  type MetricsEquivalence,
  type MetricsResponse,
} from "@/lib/llm-error-metrics";
import { normalizeText } from "@/lib/utils";
import { formatCardAnswer } from "@/lib/verdict-display";
import type { PydanticField } from "@/lib/types";

const MIGRATION = join(__dirname, "..", "..", "..", "supabase", "migrations", "20260927140000_both_correct_common_value.sql");

function field(name: string, overrides: Partial<PydanticField> = {}): PydanticField {
  return { id: `00000000-0000-4000-8000-0000000000${name.length}`, name, type: "single", options: ["A", "B"], description: name, hash: `h-${name}`, ...overrides };
}

const CONDITION = { field: "g0", equals: "Sim" } as unknown as PydanticField["condition"];

// O mesmo documento da suíte SQL: L é o LLM, H1 e H2 os pesquisadores
// correntes, HV a versão anterior de H2 com as respostas da arbitragem antiga.
const answers = {
  L: { s: "A", s2: "A", s3: "A", s4: "", s5: "Z", m: ["B", "A"], g0: "Não", cm: [], t: "Adalimumabe", t2: "Dipirona", t3: "Soro" },
  H1: { s: "A", s2: "A", s3: "A", s4: "", s5: "Z", m: ["A", "B"], g0: "Não", t: "adalimumabé ", t2: "Dipirona", t3: "soro fisiologico" },
  H2: { s: " a", s2: "B", s3: "A", s4: "", s5: "Z", m: ["B", "A"], g0: "Não", t: "ADA", t2: "dipirona", t3: "Soro fisiológico" },
  HV: { s: "B", s2: "B", s4: "A", s5: "A", m: ["C"], g0: "Sim", c: "A", cm: ["A"], t: "Outro remédio", t2: "Metamizol", t3: "Glicose" },
} as const;

function response(id: keyof typeof answers, overrides: Partial<MetricsResponse> = {}): MetricsResponse {
  return {
    id, document_id: "doc1", respondent_type: id === "L" ? "llm" : "humano", respondent_name: id,
    is_latest: id !== "HV", answers: { ...answers[id] } as Record<string, unknown>, justifications: null,
    created_at: "2026-09-01T00:00:00Z", schema_version_major: 1, schema_version_minor: 0, schema_version_patch: 0,
    ...overrides,
  };
}

function pair(fieldName: string, a: string, b: string, snapA: unknown, snapB: unknown): MetricsEquivalence {
  return { document_id: "doc1", field_name: fieldName, response_a_id: a, response_b_id: b, response_a_answer_snapshot: snapA, response_b_answer_snapshot: snapB };
}

const documentResponses = (["L", "H1", "H2", "HV"] as const).map((id) => response(id));
const equivalences = [
  pair("t", "H1", "H2", "adalimumabé ", "ADA"),
  pair("t2", "L", "HV", "Dipirona", "Metamizol"),
  // Snapshot de H1 que não é mais a resposta dele: o par não vale.
  pair("t3", "L", "H1", "Soro", "outra coisa"),
];

const scenarios: Array<[string, PydanticField, string, unknown]> = [
  ["s: todos dizem A, o veredito B", field("s"), "B", { value: "A" }],
  ["s2: os pesquisadores discordam", field("s2"), "B", null],
  ["s3: o veredito já é a resposta do LLM", field("s3"), "A", null],
  ["s4: todos em branco sem condição", field("s4"), "A", null],
  ["s5: todos dizem Z, fora das opções", field("s5"), "A", null],
  ["m: a mesma seleção em ordens diferentes", field("m", { type: "multi", options: ["A", "B", "C"] }), '{"C":true}', { value: ["B", "A"] }],
  ["c: condicional em branco no LLM e nos pesquisadores", field("c", { condition: CONDITION }), "A", { value: "" }],
  ["cm: condicional múltipla, [] no LLM e sem a chave nos pesquisadores", field("cm", { type: "multi", condition: CONDITION }), '{"A":true}', { value: [] }],
  ["t: acento, caixa e par = vigente", field("t", { type: "text", options: null }), "Outro remédio", { value: "Adalimumabe" }],
  ["t2: par = liga o LLM a resposta que casa com o veredito", field("t2", { type: "text", options: null }), "Metamizol", null],
  ["t3: par = com snapshot velho não junta os pesquisadores ao LLM", field("t3", { type: "text", options: null }), "Glicose", null],
];

function commonValue(f: PydanticField, verdict: string, overrides: { chosenResponseId?: string | null; responses?: MetricsResponse[] } = {}) {
  const docResponses = overrides.responses ?? documentResponses;
  return bothCorrectCommonValue({
    field: f, verdict, chosenResponseId: overrides.chosenResponseId ?? "HV",
    llmResponse: docResponses.find((r) => r.id === "L")!,
    documentResponses: docResponses,
    currentHumans: docResponses.filter((r) => r.respondent_type === "humano" && r.is_latest),
    equivalences: equivalences.filter((p) => p.field_name === f.name),
  });
}

describe("bothCorrectCommonValue: os cenários da suíte SQL", () => {
  it.each(scenarios)("%s", (_label, f, verdict, expected) => {
    expect(commonValue(f, verdict)).toEqual(expected);
  });

  it("a arbitragem que escolheu a própria resposta do LLM não diverge dela", () => {
    expect(commonValue(field("s"), "B", { chosenResponseId: "L" })).toBeNull();
  });

  it("um pesquisador que muda a resposta tira o valor comum", () => {
    const changed = documentResponses.map((r) => (r.id === "H2" ? { ...r, answers: { ...r.answers, s: "B" } } : r));
    expect(commonValue(field("s"), "B", { responses: changed })).toBeNull();
  });

  it("sem pesquisador corrente não há valor comum", () => {
    expect(bothCorrectCommonValue({
      field: field("s"), verdict: "B", chosenResponseId: "HV", llmResponse: documentResponses[0],
      documentResponses, currentHumans: [], equivalences: [],
    })).toBeNull();
  });
});

// A matriz de supabase/tests/both_correct_common_value.test.sql, bloco (b).
describe("funções puras, a mesma matriz da cópia SQL", () => {
  it.each([
    ["  Adalimumabé  ", "adalimumabe"],
    ["ÁRVORE\u00A0\u2003 Grande", "arvore grande"],
    ["Ação", "acao"],
    ["a\tb\nc", "a b c"],
    ["a^b`c", "abc"],
    ["x\uFEFF", "x"],
    ["", ""],
  ])("normalizeText(%j) = %j", (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });

  const textField = field("t", { type: "text", options: null });
  const multiField = field("m", { type: "multi", options: ["A", "B", "C"] });
  it.each<[string, PydanticField, unknown, unknown, boolean]>([
    ["texto: acento e caixa", textField, "Ação", " acao ", true],
    ["texto: diferente", textField, "A", "B", false],
    ["branco: ausente e vazio", textField, undefined, "", true],
    ["branco: null e espaço", textField, null, " ", true],
    ["branco contra resposta", textField, undefined, "A", false],
    ["multi: ordem não importa", multiField, ["B", "A"], ["A", "B"], true],
    ["multi: conjunto diferente", multiField, ["A"], ["A", "B"], false],
    ["multi: [] é branco", multiField, [], undefined, true],
    ["multi legado em texto compara por texto", multiField, "A", "B", false],
    ["objeto: mesmas chaves", textField, { anos: "2" }, { anos: "2" }, true],
    ["objeto: valor diferente", textField, { anos: "2" }, { anos: "3" }, false],
    ["array em texto: normaliza os itens", textField, ["Ação"], ["acao"], true],
  ])("answersAgree %s", (_label, f, a, b, expected) => {
    expect(answersAgree(f, a, b)).toBe(expected);
  });

  it.each<[string, PydanticField, string, unknown, boolean]>([
    ["texto: igual normalizado", textField, "acao", "Ação", true],
    ["texto: diferente", textField, "B", "A", false],
    ["texto: veredito em branco e resposta ausente", textField, " ", undefined, true],
    ["texto: veredito em branco e resposta preenchida", textField, "", "A", false],
    ["data parcial exibida no card", textField, "—/03/2024", "XX/03/2024", true],
    ["subcampos exibidos no card", textField, "anos: 2, meses: 3", { anos: "2", meses: "3" }, true],
    ["lista exibida no card", textField, "A, B", ["A", "B"], true],
    ["multi: JSON do veredito", multiField, '{"A":true,"B":true,"C":false}', ["B", "A"], true],
    ["multi: JSON do veredito diferente", multiField, '{"A":true}', ["A", "B"], false],
    ["multi: texto votado em card", multiField, "A, C", ["C", "A"], true],
    ["multi: veredito vazio e resposta vazia", multiField, "", [], true],
    ["multi: veredito vazio e resposta marcada", multiField, "", ["A"], false],
    ["texto: resposta ausente e veredito preenchido", textField, "A", undefined, false],
    ["subcampo numérico: 2.0 exibido como 2", textField, "dose: 2", JSON.parse('{"dose":2.0}'), true],
    ["número: 1.50 exibido como 1.5", textField, "1.5", JSON.parse("1.50"), true],
    ["número: 1e21 exibido como 1e+21", textField, "1e+21", JSON.parse("1e21"), true],
    ["número: 1e21 não é exibido por extenso", textField, "1000000000000000000000", JSON.parse("1e21"), false],
  ])("verdictMatchesAnswer %s", (_label, f, verdict, answer, expected) => {
    expect(verdictMatchesAnswer(f, verdict, answer)).toBe(expected);
  });

  // O texto do card com número: a mesma matriz de `answer_card_text` na cópia
  // SQL, com a resposta como o JSON que vem do banco.
  it.each([
    ["2.0", "2"],
    ["1.50", "1.5"],
    ["1e21", "1e+21"],
    ["1E+21", "1e+21"],
    ["1e20", "100000000000000000000"],
    ["-1.5e-7", "-1.5e-7"],
    ["0.000001", "0.000001"],
    ["0.0000001", "1e-7"],
    ["-0", "0"],
    ["0", "0"],
    ["123456789012345678901", "123456789012345680000"],
    ["{\"dose\":2.0}", "dose: 2"],
    ["[1.50,true,null,\"x\"]", "1.5, true, , x"],
    ["{\"a\":1e21,\"b\":false}", "a: 1e+21, b: false"],
    ["12.340e1", "123.4"],
    ["1e400", "Infinity"],
    ["-1e400", "-Infinity"],
    ["1e-400", "0"],
    ["0.1", "0.1"],
    ["1.0000000000000002", "1.0000000000000002"],
  ])("formatCardAnswer(%s) = %j", (json, expected) => {
    expect(formatCardAnswer(JSON.parse(json))).toBe(expected);
  });
});

// A cópia SQL de `normalizeText` e de `trim()` usa classes de caracteres
// escritas na migration. Elas precisam ser exatamente os conjuntos que o JS
// usa (`\p{Diacritic}` e `\s`); a suíte SQL prende só alguns membros, e este
// teste prende as classes inteiras contra o motor do Node.
describe("classes de caracteres da cópia SQL", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  function classAfter(marker: string): Set<number> {
    const body = new RegExp(`-- classe: ${marker}\\n\\s*'\\^?\\[(.*?)\\]`).exec(sql)?.[1];
    expect(body, marker).toBeDefined();
    const tokens = [...body!.matchAll(/\\u([0-9A-F]{4})|\\U([0-9A-F]{8})|(-)/g)].map(([, bmp, astral, dash]) =>
      dash ? "-" : parseInt(bmp ?? astral, 16));
    const set = new Set<number>();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i + 1] === "-") {
        for (let c = tokens[i] as number; c <= (tokens[i + 2] as number); c++) set.add(c);
        i += 2;
      } else set.add(tokens[i] as number);
    }
    return set;
  }

  function jsSet(test: (ch: string) => boolean): number[] {
    const out: number[] = [];
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      if (test(String.fromCodePoint(c))) out.push(c);
    }
    return out;
  }

  it("diacrítico é exatamente \\p{Diacritic}", () => {
    expect([...classAfter("diacritico do JS")].sort((a, b) => a - b)).toEqual(jsSet((ch) => /\p{Diacritic}/u.test(ch)));
  });

  it("espaço é exatamente o \\s e o trim() do JS", () => {
    const expected = jsSet((ch) => /\s/.test(ch));
    expect([...classAfter("espaco do JS")].sort((a, b) => a - b)).toEqual(expected);
    expect(jsSet((ch) => ch.trim() === "")).toEqual(expected);
  });
});
