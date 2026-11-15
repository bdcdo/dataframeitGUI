import fc from "fast-check";
import { fieldHashOf } from "@/lib/schema-utils";
import {
  pydanticFieldNameIssue,
  type ConditionScalar,
  type FieldCondition,
  type PydanticField,
  type PydanticFieldTarget,
  type SubfieldDef,
} from "@/lib/pydantic-field";

// Gerador de schemas arbitrários e salváveis (passam por
// `parseSaveablePydanticFields`) para o teste de propriedade do round-trip
// `generatePydanticCode` ↔ `compile_pydantic` (issue #525).
//
// Os textos misturam o que o escape do gerador precisa tratar (aspas, barra
// invertida, quebras de linha, tab, chaves, acento, emoji) com o que o
// compilador remove de volta (". " e ":" dos sufixos da description).
const TEXT_UNIT = fc.constantFrom(
  "a", "b", "Z", "0", " ", ".", ":", "_", '"', "'", "\\", "\n", "\t", "\r",
  "{", "}", "ç", "ã", "😀",
);
const anyText = fc.string({ unit: TEXT_UNIT, maxLength: 10 });
const nonBlankText = anyText.filter((s) => s.trim().length > 0);
// `help_text` e `justification_prompt` saem aparados no código (o gerador faz
// `.trim()`), e é aparados que a GUI os grava; o gerador de casos fica na forma
// que chega ao save.
const trimmedText = nonBlankText.map((s) => s.trim());

// Nomes que a validação recusa (palavra reservada do Python, `_` inicial,
// `model_config`...) ficam fora pela própria `pydanticFieldNameIssue`, e não por
// uma lista copiada aqui: o gerador sorteia exatamente os nomes que a GUI salva.
//
// Nomes que sombreiam algo que o código gerado usa (`str`, `list`, `Field`
// minúsculo não colide) ou um atributo do BaseModel: o compilador os aceita, e
// é bom que o gerador os sorteie com frequência.
const TRICKY_NAMES = ["str", "list", "optional", "literal", "analysis", "json", "copy", "fields"];
const identifier = fc
  .oneof(
    { weight: 4, arbitrary: fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/) },
    { weight: 1, arbitrary: fc.constantFrom(...TRICKY_NAMES) },
  )
  .filter((name) => pydanticFieldNameIssue(name) === null);

const conditionScalar: fc.Arbitrary<ConditionScalar> = fc.oneof(
  nonBlankText,
  fc.integer({ min: -1000, max: 1000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
  fc.boolean(),
);

// Opções distintas: `Literal["x", "x"]` vira `Literal["x"]` no Python, e a
// GUI não barra opção repetida — outra lacuna da validação, fora do gerador.
const options = fc.uniqueArray(nonBlankText, { minLength: 1, maxLength: 4 });

const subfields: fc.Arbitrary<SubfieldDef[]> = fc.uniqueArray(
  fc.record(
    {
      key: identifier,
      label: nonBlankText,
      required: fc.boolean(),
    },
    { requiredKeys: ["key", "label"] },
  ),
  { selector: (sf) => sf.key, minLength: 1, maxLength: 3 },
);

const target = fc.constantFrom<PydanticFieldTarget>("all", "llm_only", "human_only", "none");

// As escolhas independentes que definem um campo. `buildField` descarta as que
// não fazem sentido para o tipo sorteado (opções em texto, `allow_other` fora
// de escolha, subcampos fora de texto), então todo campo construído está na
// forma canônica que a GUI grava, e trocar uma escolha só por outra (o que o
// teste de injetividade faz) continua produzindo um campo válido.
export interface FieldSpec {
  id: string;
  name: string;
  type: PydanticField["type"];
  choiceOptions: string[];
  dateOptions: string[] | undefined;
  description: string;
  help_text: string | undefined;
  target: PydanticFieldTarget | undefined;
  required: boolean | undefined;
  allow_other: boolean | undefined;
  subfields: SubfieldDef[] | undefined;
  subfield_rule: PydanticField["subfield_rule"];
  condition: FieldCondition | undefined;
  justification_prompt: string | undefined;
  question_revision: number | undefined;
}

const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });

// Condição sobre um campo anterior. Valor string tem de estar entre as opções
// do gatilho quando ele tem opções (`validateConditionValues`); número e
// booleano passam sempre.
function conditionOn(trigger: PydanticField): fc.Arbitrary<FieldCondition> {
  const value: fc.Arbitrary<ConditionScalar> = trigger.options?.length
    ? fc.oneof(
        { weight: 3, arbitrary: fc.constantFrom(...trigger.options) },
        { weight: 1, arbitrary: conditionScalar.filter((v) => typeof v !== "string") },
      )
    : conditionScalar;
  const values = fc.array(value, { minLength: 1, maxLength: 3 });
  const field = trigger.name;
  return fc.oneof(
    value.map((equals) => ({ field, equals })),
    value.map((not_equals) => ({ field, not_equals })),
    values.map((list) => ({ field, in: list })),
    values.map((list) => ({ field, not_in: list })),
    fc.boolean().map((exists) => ({ field, exists })),
  );
}

// `triggers` são os campos anteriores ao que está sendo gerado: a condição só
// pode apontar para eles.
export function fieldSpec(triggers: PydanticField[]): fc.Arbitrary<FieldSpec> {
  const condition = triggers.length
    ? optional(fc.constantFrom(...triggers).chain(conditionOn))
    : fc.constant(undefined);
  return fc.record({
    id: fc.uuid(),
    name: identifier,
    type: fc.constantFrom<PydanticField["type"]>("single", "multi", "text", "date"),
    choiceOptions: options,
    dateOptions: optional(options),
    description: nonBlankText,
    help_text: optional(trimmedText),
    target: optional(target),
    required: optional(fc.boolean()),
    allow_other: optional(fc.boolean()),
    subfields: optional(subfields),
    subfield_rule: optional(fc.constantFrom<"all" | "at_least_one">("all", "at_least_one")),
    condition,
    justification_prompt: optional(trimmedText),
    question_revision: optional(fc.integer({ min: 1, max: 9 })),
  });
}

export function buildField(spec: FieldSpec): PydanticField {
  const isChoice = spec.type === "single" || spec.type === "multi";
  const hasSubfields = spec.type === "text" && spec.subfields !== undefined;
  const field: PydanticField = {
    id: spec.id,
    name: spec.name,
    type: spec.type,
    options: isChoice
      ? spec.choiceOptions
      : spec.type === "date"
        ? (spec.dateOptions ?? null)
        : null,
    description: spec.description,
    help_text: spec.help_text,
    target: spec.target,
    required: spec.required,
    allow_other: isChoice ? spec.allow_other : undefined,
    subfields: hasSubfields ? spec.subfields : undefined,
    subfield_rule: hasSubfields ? spec.subfield_rule : undefined,
    condition: spec.condition,
    justification_prompt: spec.justification_prompt,
    question_revision: spec.question_revision,
  };
  // Sem chaves `undefined`: o objeto fica igual ao que volta de um JSON.
  return Object.fromEntries(
    Object.entries(field).filter(([, value]) => value !== undefined),
  ) as PydanticField;
}

// `hash` é derivado (o compilador o recalcula), então fica fora de `FieldSpec`
// e só entra aqui, metade das vezes, como o save grava: presente nos campos
// salvos e ausente nos que ainda não passaram por um save.
const savedField = (triggers: PydanticField[]): fc.Arbitrary<PydanticField> =>
  fc
    .tuple(fieldSpec(triggers).map(buildField), fc.boolean())
    .map(([built, withHash]) => (withHash ? { ...built, hash: fieldHashOf(built) } : built));

// Schema de 1 a `maxFields` campos com nomes e ids únicos; a condição de cada
// campo só referencia campos anteriores, como `saveablePydanticFieldsSchema`
// exige.
export function schemaArbitrary(maxFields = 4): fc.Arbitrary<PydanticField[]> {
  const extend = (fields: PydanticField[]): fc.Arbitrary<PydanticField[]> => {
    if (fields.length >= maxFields) return fc.constant(fields);
    const next = savedField(fields).filter(
      (f) => !fields.some((other) => other.name === f.name || other.id === f.id),
    );
    return fc.oneof(
      fc.constant(fields),
      next.chain((field) => extend([...fields, field])),
    );
  };
  return savedField([]).chain((first) => extend([first]));
}
