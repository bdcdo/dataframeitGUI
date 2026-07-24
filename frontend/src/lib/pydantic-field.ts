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
//
// `id` e a identidade do campo (chave de merge, React key, unicidade do
// rascunho); `name` e conteudo editavel e identidade de auditoria
// (`diffFields`/`schema_change_log` seguem chaveando por nome). Separar os dois
// e o que permite nome duplicado transitorio no editor sem quebrar o merge —
// ver issue #473. Exportado para o schema de draft legado (v4) derivar a
// variante sem `id` via `.omit()` em vez de duplicar o shape.
export const pydanticFieldSchema = z.strictObject({
  id: z.uuid(),
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

type FieldsRefinement = (
  fields: Array<z.infer<typeof pydanticFieldSchema>>,
  context: z.RefinementCtx,
) => void;

const refineUniqueIds: FieldsRefinement = (fields, context) => {
  const ids = new Set<string>();
  for (let index = 0; index < fields.length; index += 1) {
    const id = fields[index].id;
    if (ids.has(id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `Campo ${index + 1}: id "${id}" duplicado`,
      });
    }
    ids.add(id);
  }
};

const refineUniqueNames: FieldsRefinement = (fields, context) => {
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
};

// Fronteira do estado EDITAVEL (GUI e rascunho local): ids unicos sao
// invariante dura — sao a identidade que o merge e as React keys usam — mas
// nome duplicado e estado transitorio legitimo (renomear q2 -> q10 passa por
// "q1" quando q1 existe). A duplicata de nome so e barrada na fronteira de
// save (`saveablePydanticFieldsSchema`) e na de persistencia.
export const editablePydanticFieldsSchema = z
  .array(pydanticFieldSchema)
  .superRefine(refineUniqueIds);

// Fronteira do estado PERSISTIDO (`projects.pydantic_fields`, snapshot base do
// rascunho, retorno do recover): alem de ids unicos, nomes unicos — o banco
// nunca guarda duplicata.
export const pydanticFieldsSchema =
  editablePydanticFieldsSchema.superRefine(refineUniqueNames);

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
export type PydanticFieldTarget = z.infer<typeof pydanticFieldTargetSchema>;
export type PydanticSubfieldRule = z.infer<typeof pydanticSubfieldRuleSchema>;
export type SubfieldDef = z.infer<typeof subfieldDefSchema>;

// `required`, `target`, `allow_other` e `subfield_rule` sao opcionais: ausente
// significa o default, nao "sem valor". Estes resolvedores sao a unica derivacao
// desses defaults — antes cada consumidor tinha a sua (`?? true`, `?? null`,
// `Boolean(...)`, `!== false`), e as versoes divergiam entre si:
//
//   - `snapshotOf` normalizava `?? null` e `classifyChange` normalizava
//     `?? "all"`, entao um campo legado sem `target` e um recuperado por
//     `compile_pydantic` (que sempre grava `target: "all"`) eram iguais para o
//     versionamento e diferentes para `sameFieldContent` — conflito de merge
//     fabricado, o mesmo sintoma que o `hash` ja causou.
//   - o diff de historico usava `Boolean(...)`, e `Boolean(null)` e `false`
//     enquanto o default de `required` e `true`: marcar um campo como opcional
//     gravava o log mas nao renderizava linha nenhuma.
//
// Aceitam `null` junto de `undefined` porque `schema_change_log` guarda
// payloads gravados com `?? null` antes desta mudanca: o historico antigo tem
// que resolver para o mesmo default que o campo vivo.
export function resolveRequired(value: boolean | null | undefined): boolean {
  return value ?? true;
}

export function resolveTarget(
  value: PydanticFieldTarget | null | undefined,
): PydanticFieldTarget {
  return value ?? "all";
}

export function resolveAllowOther(value: boolean | null | undefined): boolean {
  return value ?? false;
}

// A quarta, e a que faltava: `_assemble_field_dict` grava `subfield_rule or "all"`
// sempre que ha subcampos, o `EditFieldDialog` promove `?? "all"` ao salvar, e o
// gerador omite a chave quando e "all" — tres consumidores concordando que ausente
// significa "all", enquanto `snapshotOf` normalizava para `null`. Bastava um
// coordenador corrigir a descricao de um campo legado pela aba Comentarios para o
// default virar explicito e o save inteiro ser classificado como MINOR, com
// entrada de auditoria de uma mudanca que ninguem fez.
//
// Quem nao tem subcampos nao tem o que regrar, mas nao precisa de tratamento
// proprio: os dois lados de qualquer comparacao resolvem para "all" e a
// propriedade some do diff sozinha.
export function resolveSubfieldRule(
  value: PydanticSubfieldRule | null | undefined,
): PydanticSubfieldRule {
  return value ?? "all";
}

export const PYDANTIC_FIELD_PROPERTY_KEYS = Object.freeze(
  Object.keys(pydanticFieldSchema.shape).sort(),
);

// Identidade de campo nova. `crypto.randomUUID` so existe em contexto seguro
// (HTTPS/localhost — mesmo motivo do fallback de `makeId` em utils.ts), mas
// aqui o fallback nao pode ser um id com prefixo arbitrario: o contrato
// (`z.uuid()` acima e a CHECK constraint em `projects.pydantic_fields`) exige
// UUID, entao o fallback monta um v4 valido com `getRandomValues`, que e
// disponivel tambem em contexto inseguro.
export function generateFieldId(): string {
  const cryptoApi = globalThis.crypto;
  const native = cryptoApi?.randomUUID?.();
  if (native) return native;
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseEditablePydanticFields(
  value: unknown,
): PydanticField[] | null {
  const result = editablePydanticFieldsSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parsePydanticFields(value: unknown): PydanticField[] | null {
  const result = pydanticFieldsSchema.safeParse(value);
  return result.success ? result.data : null;
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
