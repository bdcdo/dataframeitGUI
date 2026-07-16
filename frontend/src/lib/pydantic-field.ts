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

export const pydanticFieldsSchema = z.array(pydanticFieldSchema);

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
