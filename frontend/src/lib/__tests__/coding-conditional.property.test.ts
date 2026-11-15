import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  isCodingComplete,
  isFieldAnswered,
  missingRequiredHumanFields,
} from "@/lib/coding-completeness";
import {
  clearHiddenConditionalAnswers,
  dropHiddenConditionals,
  isFieldVisible,
} from "@/lib/conditional";
import { OTHER_PREFIX } from "@/lib/other-option";
import { conditionValues, resolveRequired, resolveTarget } from "@/lib/pydantic-field";
import type { PydanticField } from "@/lib/types";
import { schemaArbitrary } from "./pydantic-field-arbitrary";

// Propriedades das duas réguas da codificação: `dropHiddenConditionals` (a
// fronteira de leitura e escrita das respostas) e `isCodingComplete` (quando a
// codificação conta como concluída). Os schemas saem do mesmo gerador do
// round-trip (#525), com condição sobre campo anterior nos 5 operadores, e as
// respostas sorteiam, por campo, os valores que mexem nas duas réguas.

type Answers = Record<string, unknown>;

// Uma resposta que `isFieldAnswered` aceita, na forma que a UI grava.
function validAnswer(field: PydanticField): unknown {
  if (field.type === "single") return field.options![0];
  if (field.type === "multi") return [field.options![0]];
  if (field.subfields?.length) {
    return Object.fromEntries(field.subfields.map((sf) => [sf.key, "x"]));
  }
  return field.type === "date" ? "2024-01-31" : "texto";
}

// Valores de um campo: vazios, a resposta válida, as opções, os valores que
// as condições sobre ele testam (para que as condições acertem e errem) e as
// formas incompletas de cada tipo.
function valueArbitrary(field: PydanticField, fields: PydanticField[]): fc.Arbitrary<unknown> {
  const tested = fields.flatMap((f) =>
    f.condition?.field === field.name ? conditionValues(f.condition) : [],
  );
  const scalars: unknown[] = [validAnswer(field), ...(field.options ?? []), ...tested];
  // Os vazios pesam mais: é neles que as réguas divergem (`""` é valor para
  // `not_equals`, `null` e ausente não).
  const shapes: fc.Arbitrary<unknown>[] = [
    fc.constantFrom<unknown>(null, ""),
    fc.constantFrom(...scalars),
  ];
  if (field.type === "single") shapes.push(fc.constantFrom(OTHER_PREFIX, `${OTHER_PREFIX}x`));
  if (field.type === "multi") {
    const pool = [...field.options!, OTHER_PREFIX, `${OTHER_PREFIX}x`];
    shapes.push(fc.subarray(pool));
  }
  if (field.subfields?.length) {
    const keys = field.subfields.map((sf) => sf.key);
    shapes.push(
      fc.dictionary(fc.constantFrom(...keys), fc.constantFrom("", " ", "x", null), {
        maxKeys: keys.length,
      }),
    );
  }
  return fc.oneof(...shapes);
}

// Chave ausente é sorteada à parte (`undefined` some do objeto), e uma chave
// fora do schema entra às vezes: a fronteira não pode tocá-la.
function answersArbitrary(fields: PydanticField[]): fc.Arbitrary<Answers> {
  const perField = fields.map((f) => fc.option(valueArbitrary(f, fields), { nil: undefined }));
  return fc
    .tuple(fc.tuple(...perField), fc.option(fc.constant("extra"), { nil: undefined }))
    .map(([values, extra]) => {
      const answers: Answers = {};
      fields.forEach((f, i) => {
        if (values[i] !== undefined) answers[f.name] = values[i];
      });
      if (extra !== undefined) answers.__fora_do_schema = extra;
      return answers;
    });
}

const schemaWithAnswers = schemaArbitrary(5).chain((fields) =>
  answersArbitrary(fields).map((answers) => ({ fields, answers })),
);

// Cabe com folga no orçamento de CPU por teste (docs/CODE_QUALITY_TOOLING.md):
// cerca de 100 ms por propriedade.
const RUNS = { numRuns: 200 };

// O primeiro teste pagaria o JIT do gerador; o aquecimento fica no
// `beforeAll`, fora do orçamento de CPU por teste.
beforeAll(() => {
  fc.sample(schemaWithAnswers, { numRuns: 100 });
});

const missingNames = (fields: PydanticField[], answers: Answers) =>
  missingRequiredHumanFields(fields, answers).map((f) => f.name);

describe("dropHiddenConditionals — propriedades", () => {
  it("é idempotente e devolve o mesmo objeto na segunda passada", () => {
    fc.assert(
      fc.property(schemaWithAnswers, ({ fields, answers }) => {
        const once = dropHiddenConditionals(fields, answers);
        expect(dropHiddenConditionals(fields, once)).toBe(once);
      }),
      RUNS,
    );
  });

  it("só remove chaves de campo condicional, sem alterar valor nem a entrada", () => {
    fc.assert(
      fc.property(schemaWithAnswers, ({ fields, answers }) => {
        const before = structuredClone(answers);
        const out = dropHiddenConditionals(fields, answers);
        expect(answers).toEqual(before);
        const conditional = new Set(fields.filter((f) => f.condition).map((f) => f.name));
        for (const key of Object.keys(answers)) {
          if (Object.hasOwn(out, key)) expect(out[key]).toBe(answers[key]);
          else expect(conditional.has(key)).toBe(true);
        }
        expect(Object.keys(out).every((key) => Object.hasOwn(answers, key))).toBe(true);
      }),
      RUNS,
    );
  });

  it("nunca remove a resposta de um campo visível", () => {
    fc.assert(
      fc.property(schemaWithAnswers, ({ fields, answers }) => {
        const out = dropHiddenConditionals(fields, answers);
        for (const f of fields) {
          if (Object.hasOwn(answers, f.name) && isFieldVisible(f, out)) {
            expect(Object.hasOwn(out, f.name)).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it("nunca mantém a resposta de um campo oculto", () => {
    fc.assert(
      fc.property(schemaWithAnswers, ({ fields, answers }) => {
        const out = dropHiddenConditionals(fields, answers);
        for (const f of fields) {
          if (Object.hasOwn(out, f.name)) expect(isFieldVisible(f, out)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  // O estado vivo da tela (`clearHiddenConditionalAnswers`) e a fronteira de
  // escrita veem os mesmos campos: senão a tela mostra uma pergunta cuja
  // resposta o save descarta.
  it("concorda com o estado vivo da tela sobre o que está visível", () => {
    fc.assert(
      fc.property(schemaWithAnswers, ({ fields, answers }) => {
        const live = clearHiddenConditionalAnswers(fields, answers);
        const saved = dropHiddenConditionals(fields, answers);
        for (const f of fields) {
          expect(isFieldVisible(f, live)).toBe(isFieldVisible(f, saved));
        }
      }),
      RUNS,
    );
  });
});

describe("isCodingComplete — propriedades", () => {
  it("é verdadeiro sse todo campo humano, obrigatório e visível tem resposta", () => {
    fc.assert(
      fc.property(schemaWithAnswers, ({ fields, answers }) => {
        const expected = fields.every((f) => {
          const target = resolveTarget(f.target);
          const demanded =
            target !== "llm_only" &&
            target !== "none" &&
            resolveRequired(f.required) &&
            isFieldVisible(f, answers);
          return !demanded || isFieldAnswered(f, answers[f.name]);
        });
        expect(isCodingComplete(fields, answers)).toBe(expected);
      }),
      RUNS,
    );
  });

  // Restrita a campo que não é gatilho de nenhuma condição: responder um
  // gatilho pode tornar visível um obrigatório ainda em branco, e aí a
  // codificação fica incompleta com razão.
  it("responder um campo que não é gatilho só o tira da lista do que falta", () => {
    fc.assert(
      fc.property(schemaWithAnswers, fc.nat(), ({ fields, answers }, pick) => {
        const triggers = new Set(fields.map((f) => f.condition?.field));
        const candidates = fields.filter((f) => !triggers.has(f.name));
        fc.pre(candidates.length > 0);
        const field = candidates[pick % candidates.length];
        const answered = { ...answers, [field.name]: validAnswer(field) };

        const expected = missingNames(fields, answers).filter((n) => n !== field.name);
        expect(missingNames(fields, answered)).toEqual(expected);
        if (isCodingComplete(fields, answers)) {
          expect(isCodingComplete(fields, answered)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  // A régua de completude e a fronteira de escrita concordam: um campo que a
  // régua cobra sobre as respostas já limpas é um que a fronteira guarda
  // quando respondido. Senão a UI pediria uma resposta que o save descartaria,
  // e a codificação nunca ficaria completa.
  it("todo campo cobrado sobre respostas limpas sobrevive à limpeza quando respondido", () => {
    fc.assert(
      fc.property(schemaWithAnswers, ({ fields, answers }) => {
        const clean = dropHiddenConditionals(fields, answers);
        for (const field of missingRequiredHumanFields(fields, clean)) {
          const answered = { ...clean, [field.name]: validAnswer(field) };
          const saved = dropHiddenConditionals(fields, answered);
          expect(saved[field.name]).toEqual(validAnswer(field));
        }
      }),
      RUNS,
    );
  });
});
