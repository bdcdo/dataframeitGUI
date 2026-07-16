import { z } from "zod";

const conditionScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

const subfieldDefSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  required: z.boolean().optional(),
});

const fieldConditionSchema = z.union([
  z.strictObject({ field: z.string(), equals: conditionScalarSchema }),
  z.strictObject({ field: z.string(), not_equals: conditionScalarSchema }),
  z.strictObject({ field: z.string(), in: z.array(conditionScalarSchema) }),
  z.strictObject({ field: z.string(), not_in: z.array(conditionScalarSchema) }),
  z.strictObject({ field: z.string(), exists: z.boolean() }),
]);

const pydanticFieldTypeSchema = z.enum([
  "single",
  "multi",
  "text",
  "date",
]);

const pydanticFieldTargetSchema = z.enum([
  "all",
  "llm_only",
  "human_only",
  "none",
]);

const pydanticSubfieldRuleSchema = z.enum(["all", "at_least_one"]);

// Este schema e a fonte runtime e estatica unica de PydanticField.
// `strictObject` faz a recuperacao de rascunhos falhar fechada quando surgir
// uma propriedade que ainda nao tenha contrato explicito.
const pydanticFieldSchema = z.strictObject({
  name: z.string(),
  type: pydanticFieldTypeSchema,
  options: z.array(z.string()).nullable(),
  description: z.string(),
  help_text: z.string().optional(),
  target: pydanticFieldTargetSchema.optional(),
  required: z.boolean().optional(),
  hash: z.string().optional(),
  subfields: z.array(subfieldDefSchema).optional(),
  subfield_rule: pydanticSubfieldRuleSchema.optional(),
  allow_other: z.boolean().optional(),
  condition: fieldConditionSchema.optional(),
  justification_prompt: z.string().optional(),
});

export const pydanticFieldsSchema = z.array(pydanticFieldSchema).superRefine(
  (fields, context) => {
    const names = new Set<string>();
    for (let index = 0; index < fields.length; index += 1) {
      const name = fields[index].name;
      if (names.has(name)) {
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `Campo ${index + 1}: nome "${name}" duplicado`,
        });
      }
      names.add(name);
    }
  },
);

const PYTHON_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const isStrictDunder = (name: string): boolean =>
  name.startsWith("__") && name.endsWith("__");

export type PydanticFieldNameIssue = "invalid" | "reserved" | null;

export function pydanticFieldNameIssue(name: string): PydanticFieldNameIssue {
  if (!name || !PYTHON_IDENTIFIER.test(name)) return "invalid";
  if (isStrictDunder(name)) return "reserved";
  return null;
}

type AddFieldIssue = (message: string, path?: PropertyKey[]) => void;

function validateFieldIdentity(
  field: PydanticField,
  label: string,
  issue: AddFieldIssue,
): void {
  const nameIssue = pydanticFieldNameIssue(field.name);
  if (nameIssue === "invalid") {
    issue(
      `${label}: nome inválido "${field.name}" (use letras minúsculas, números e _)`,
      ["name"],
    );
  } else if (nameIssue === "reserved") {
    issue(
      `${label}: nome "${field.name}" não pode começar e terminar com "__" (reservado pelo Python)`,
      ["name"],
    );
  }
  if (!field.description.trim()) {
    issue(`${label}: descrição não pode ser vazia`, ["description"]);
  }
}

function validateSubfields(
  field: PydanticField,
  label: string,
  issue: AddFieldIssue,
): void {
  const keys = new Set<string>();
  field.subfields?.forEach((subfield, index) => {
    const path = ["subfields", index, "key"];
    if (!subfield.key || !PYTHON_IDENTIFIER.test(subfield.key)) {
      issue(
        `${label}: subcampo ${index + 1} tem chave inválida "${subfield.key}"`,
        path,
      );
    } else if (isStrictDunder(subfield.key)) {
      issue(
        `${label}: subcampo "${subfield.key}" não pode começar e terminar com "__" (reservado pelo Python)`,
        path,
      );
    }
    if (keys.has(subfield.key)) {
      issue(`${label}: subcampo "${subfield.key}" duplicado`, path);
    }
    keys.add(subfield.key);
    if (!subfield.label.trim()) {
      issue(
        `${label}: subcampo ${index + 1} tem label vazio`,
        ["subfields", index, "label"],
      );
    }
  });
}

function validateOptions(
  field: PydanticField,
  label: string,
  issue: AddFieldIssue,
): void {
  const isChoice = field.type === "single" || field.type === "multi";
  if (isChoice && !field.options?.length) {
    issue(`${label}: campo de escolha precisa de pelo menos uma opção`, ["options"]);
  }
  field.options?.forEach((option, index) => {
    if (!option.trim()) {
      issue(`${label}: opção ${index + 1} está vazia`, ["options", index]);
    }
  });
}

function conditionValues(condition: FieldCondition): ConditionScalar[] {
  if ("equals" in condition) return [condition.equals];
  if ("not_equals" in condition) return [condition.not_equals];
  if ("in" in condition) return condition.in;
  if ("not_in" in condition) return condition.not_in;
  return [];
}

function conditionTrigger(
  field: PydanticField,
  earlierFields: ReadonlyMap<string, PydanticField>,
  label: string,
  issue: AddFieldIssue,
): PydanticField | null {
  const trigger = field.condition?.field;
  if (!trigger) {
    issue(`${label}: condição sem campo gatilho`, ["condition", "field"]);
    return null;
  }
  if (trigger === field.name) {
    issue(`${label}: condição não pode referenciar o próprio campo`, ["condition", "field"]);
    return null;
  }
  const triggerField = earlierFields.get(trigger);
  if (!triggerField) {
    issue(
      `${label}: campo gatilho "${trigger}" inexistente ou posterior ao campo condicional`,
      ["condition", "field"],
    );
    return null;
  }
  return triggerField;
}

function validateConditionValues(
  condition: FieldCondition,
  trigger: PydanticField,
  label: string,
  issue: AddFieldIssue,
): void {
  const values = conditionValues(condition);
  if (("in" in condition || "not_in" in condition) && values.length === 0) {
    issue(`${label}: lista de valores da condição vazia`, ["condition"]);
  }
  if (!trigger.options) return;
  const options = new Set(trigger.options);
  for (const value of values) {
    if (typeof value === "string" && !options.has(value)) {
      issue(
        `${label}: valor "${value}" não está nas opções de "${condition.field}"`,
        ["condition"],
      );
    }
  }
}

function validateCondition(
  field: PydanticField,
  earlierFields: ReadonlyMap<string, PydanticField>,
  label: string,
  issue: AddFieldIssue,
): void {
  const condition = field.condition;
  if (!condition) return;
  const trigger = conditionTrigger(field, earlierFields, label, issue);
  if (trigger) validateConditionValues(condition, trigger, label, issue);
}

const saveablePydanticFieldsSchema = pydanticFieldsSchema.superRefine(
  (fields, context) => {
    if (fields.length === 0) {
      context.addIssue({ code: "custom", message: "Adicione pelo menos um campo." });
      return;
    }

    const fieldByName = new Map<string, PydanticField>();
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      const label = `Campo ${index + 1}`;
      const issue = (message: string, path: PropertyKey[] = []) =>
        context.addIssue({ code: "custom", path: [index, ...path], message });

      validateFieldIdentity(field, label, issue);
      validateSubfields(field, label, issue);
      validateOptions(field, label, issue);
      validateCondition(field, fieldByName, label, issue);
      if (!fieldByName.has(field.name)) fieldByName.set(field.name, field);
    }
  },
);

export type ConditionScalar = z.infer<typeof conditionScalarSchema>;
export type FieldCondition = z.infer<typeof fieldConditionSchema>;
export type PydanticField = z.infer<typeof pydanticFieldSchema>;
export type SubfieldDef = z.infer<typeof subfieldDefSchema>;

export const PYDANTIC_FIELD_PROPERTY_KEYS = Object.freeze(
  Object.keys(pydanticFieldSchema.shape).sort(),
);

export function parsePydanticFields(value: unknown): PydanticField[] | null {
  const result = pydanticFieldsSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function requirePydanticFields(value: unknown): PydanticField[] {
  const fields = parsePydanticFields(value);
  if (!fields) {
    throw new Error("O schema persistido é inválido e precisa ser corrigido antes da edição.");
  }
  return fields;
}

export function parseSaveablePydanticFields(
  value: unknown,
): PydanticField[] | null {
  const result = saveablePydanticFieldsSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function validatePydanticFields(fields: PydanticField[]): string[] {
  const result = saveablePydanticFieldsSchema.safeParse(fields);
  return result.success ? [] : result.error.issues.map(({ message }) => message);
}
