import {
  PYDANTIC_FIELD_TARGETS,
  PYDANTIC_FIELD_TYPES,
  PYDANTIC_SUBFIELD_RULES,
  type FieldCondition,
  type PydanticField,
  type SubfieldDef,
} from "@/lib/types";

// Os valores literais vêm das mesmas tuplas que definem os unions em
// `types.ts`; ampliar um union amplia o parser sem uma segunda allowlist.
// O mapa abaixo continua responsável pela exaustividade das propriedades.

type Validator = (value: unknown) => boolean;
type CompleteValidatorMap<T> = {
  [Property in keyof Required<T>]: Validator;
};
type KeysOfUnion<T> = T extends T ? keyof T : never;
type ConditionOperator = Exclude<KeysOfUnion<FieldCondition>, "field">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullable(value: unknown, predicate: Validator): boolean {
  return value === undefined || value === null || predicate(value);
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return (
    typeof value === "string" &&
    (values as readonly string[]).includes(value)
  );
}

const subfieldValidators = {
  key: (value) => typeof value === "string",
  label: (value) => typeof value === "string",
  required: (value) => isNullable(value, (candidate) => typeof candidate === "boolean"),
} satisfies CompleteValidatorMap<SubfieldDef>;

const conditionOperatorValidators = {
  equals: isScalar,
  not_equals: isScalar,
  in: (value) => Array.isArray(value) && value.every(isScalar),
  not_in: (value) => Array.isArray(value) && value.every(isScalar),
  exists: (value) => typeof value === "boolean",
} satisfies Record<ConditionOperator, Validator>;

function hasOnlyValidatedKeys(
  value: Record<string, unknown>,
  validators: Record<string, Validator>,
): boolean {
  return Object.keys(value).every((key) =>
    Object.prototype.hasOwnProperty.call(validators, key),
  );
}

function matchesValidators(
  value: Record<string, unknown>,
  validators: Record<string, Validator>,
): boolean {
  return Object.entries(validators).every(([property, validate]) =>
    validate(value[property]),
  );
}

function isSubfield(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyValidatedKeys(value, subfieldValidators) &&
    matchesValidators(value, subfieldValidators)
  );
}

function isCondition(value: unknown): boolean {
  if (!isRecord(value) || typeof value.field !== "string") return false;
  const operators = Object.keys(value).filter(
    (key): key is ConditionOperator =>
      Object.prototype.hasOwnProperty.call(conditionOperatorValidators, key),
  );
  if (operators.length !== 1 || Object.keys(value).length !== 2) return false;
  const operator = operators[0];
  return conditionOperatorValidators[operator](value[operator]);
}

// Este mapa é o contrato runtime canônico de PydanticField. `satisfies` torna
// uma propriedade nova do tipo um erro de compilação até que seu parser seja
// definido, enquanto as chaves derivadas abaixo mantêm a leitura fail-closed.
const pydanticFieldValidators = {
  name: (value) => typeof value === "string",
  type: (value) => isOneOf(value, PYDANTIC_FIELD_TYPES),
  options: (value) => value === null || isStringArray(value),
  description: (value) => typeof value === "string",
  help_text: (value) => isNullable(value, (candidate) => typeof candidate === "string"),
  target: (value) =>
    isNullable(value, (candidate) => isOneOf(candidate, PYDANTIC_FIELD_TARGETS)),
  required: (value) => isNullable(value, (candidate) => typeof candidate === "boolean"),
  hash: (value) => isNullable(value, (candidate) => typeof candidate === "string"),
  subfields: (value) =>
    isNullable(value, (candidate) => Array.isArray(candidate) && candidate.every(isSubfield)),
  subfield_rule: (value) =>
    isNullable(value, (candidate) => isOneOf(candidate, PYDANTIC_SUBFIELD_RULES)),
  allow_other: (value) => isNullable(value, (candidate) => typeof candidate === "boolean"),
  condition: (value) => isNullable(value, isCondition),
  justification_prompt: (value) =>
    isNullable(value, (candidate) => typeof candidate === "string"),
} satisfies CompleteValidatorMap<PydanticField>;

export const PYDANTIC_FIELD_PROPERTY_KEYS = Object.freeze(
  Object.keys(pydanticFieldValidators).sort(),
);

function parsePydanticField(value: unknown): PydanticField | null {
  if (
    !isRecord(value) ||
    !hasOnlyValidatedKeys(value, pydanticFieldValidators) ||
    !matchesValidators(value, pydanticFieldValidators)
  ) {
    return null;
  }
  return value as unknown as PydanticField;
}

export function parsePydanticFields(value: unknown): PydanticField[] | null {
  if (!Array.isArray(value)) return null;
  const fields = value.map(parsePydanticField);
  return fields.some((field) => field === null)
    ? null
    : (fields as PydanticField[]);
}
