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

// Forma canonica do `id`: hifens e minusculas, sem exigir versao nem variante.
// E a mesma regex da CHECK projects_pydantic_fields_shape, e a mesma forma que
// `_parse_field_id` aceita no compilador Python (por ida e volta em
// uuid.UUID). `z.uuid()` divergia dos dois nos dois sentidos (aceitava caixa
// alta e recusava UUID fora do padrao RFC), e um id valido para o banco
// deixava o editor sem abrir.
export const FIELD_ID_PATTERN = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/;

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
  id: z.string().regex(FIELD_ID_PATTERN),
  name: z.string(),
  type: pydanticFieldTypeSchema,
  options: z.array(z.string()).nullable(),
  description: z.string(),
  help_text: z.string().optional(),
  target: pydanticFieldTargetSchema.optional(),
  required: z.boolean().optional(),
  hash: z.string().optional(),
  // Contador de revisões da pergunta por mudança de instrução ("Muda como
  // responder"). Ausente é "nenhuma revisão", e não um default: o hash só o
  // inclui quando presente, para que nenhum hash existente mude. Ver
  // `computeFieldHash` em schema-utils.ts.
  question_revision: z.number().int().min(1).optional(),
  subfields: z.array(subfieldDefSchema).optional(),
  subfield_rule: pydanticSubfieldRuleSchema.optional(),
  allow_other: z.boolean().optional(),
  condition: fieldConditionSchema.optional(),
  justification_prompt: z.string().optional(),
});

// A checagem de nome duplicado só lê `name`, então tipar por essa propriedade
// (e não por `PydanticField`) deixa o mesmo refinamento servir ao contrato
// atual e ao shape v4 do envelope de rascunho, que não tem `id`. Sem isso, o
// schema-draft mantinha uma cópia literal desta função — e cópia de regra de
// validação é exatamente o que desanda em silêncio quando a mensagem ou o path
// mudam de um lado só.
type FieldsRefinement<T> = (fields: T[], context: z.RefinementCtx) => void;

// Rótulo do campo nas mensagens de validação: a posição sozinha ("Campo 2")
// obrigava a contar cards, e a aba Schema e o `EditFieldDialog` não numeram os
// campos. O nome acompanha a posição quando existe (#502).
function fieldLabel(index: number, name: unknown): string {
  const position = `Campo ${index + 1}`;
  return typeof name === "string" && name ? `${position} ("${name}")` : position;
}

export const refineUniqueNames: FieldsRefinement<{ name: string }> = (
  fields,
  context,
) => {
  const names = new Set<string>();
  for (let index = 0; index < fields.length; index += 1) {
    const name = fields[index].name;
    if (names.has(name)) {
      context.addIssue({
        code: "custom",
        path: [index, "name"],
        message: `${fieldLabel(index, name)}: nome duplicado`,
      });
    }
    names.add(name);
  }
};

const refineUniqueIds: FieldsRefinement<z.infer<typeof pydanticFieldSchema>> = (
  fields,
  context,
) => {
  const ids = new Set<string>();
  for (let index = 0; index < fields.length; index += 1) {
    const id = fields[index].id;
    if (ids.has(id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `${fieldLabel(index, fields[index].name)}: id "${id}" duplicado`,
      });
    }
    ids.add(id);
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

// Nome de campo e de subcampo. Exportado porque o nome também entra como
// caminho JSON em queries do PostgREST (value-equivalence-query.ts).
export const PYTHON_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// Nomes que casam com PYTHON_IDENTIFIER mas com que o código gerado não
// compila, como campo e como subcampo. É o conjunto exato que
// `compile_pydantic` recusa: `backend/tests/test_field_names.py` confere, pelo
// arquivo `reserved_field_names.json`, que o backend recusa estes nomes e
// aceita todos os outros candidatos (palavras-chave leves do Python e atributos
// do `BaseModel`), então uma versão nova do Python ou do Pydantic que reserve
// mais um nome reprova lá (#525).
//
// Palavra reservada do Python: `class: str` é erro de sintaxe. As palavras-
// chave leves (`match`, `case`, `type`) compilam e ficam de fora.
export const PYTHON_KEYWORDS: readonly string[] = Object.freeze([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
  "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield",
]);
// Membros do `BaseModel` que o Pydantic recusa como nome de campo. Os demais
// atributos dele (`json`, `copy`, `model_fields`...) só geram aviso.
export const PYDANTIC_RESERVED_NAMES: readonly string[] = Object.freeze([
  "model_config", "model_dump", "model_dump_json", "model_validate",
  "model_validate_json", "model_validate_strings",
]);
const RESERVED_NAMES = new Map<string, PydanticFieldNameIssue>([
  ...PYTHON_KEYWORDS.map((name) => [name, "keyword"] as const),
  ...PYDANTIC_RESERVED_NAMES.map((name) => [name, "pydantic"] as const),
]);

// "private": o Pydantic recusa nome com `_` inicial, o que inclui os dunders
// (`__class__`) que a allowlist do compilador também barra por segurança.
export type PydanticFieldNameIssue =
  | "invalid"
  | "private"
  | "keyword"
  | "pydantic"
  | null;

export function pydanticFieldNameIssue(name: string): PydanticFieldNameIssue {
  if (!name || !PYTHON_IDENTIFIER.test(name)) return "invalid";
  if (name.startsWith("_")) return "private";
  return RESERVED_NAMES.get(name) ?? null;
}

// Complemento de "nome ..." / "subcampo "x" ..." nas mensagens de validação e
// no aviso do FieldCard.
export const RESERVED_NAME_REASON = {
  private: 'não pode começar com "_" (o Pydantic não aceita)',
  keyword: "é palavra reservada do Python",
  pydantic: "é reservado pelo Pydantic",
} as const satisfies Record<Exclude<PydanticFieldNameIssue, "invalid" | null>, string>;

type AddFieldIssue = (message: string, path?: PropertyKey[]) => void;

function validateFieldIdentity(
  field: PydanticField,
  label: string,
  issue: AddFieldIssue,
): void {
  const nameIssue = pydanticFieldNameIssue(field.name);
  if (nameIssue === "invalid") {
    issue(
      `${label}: nome inválido (use letras minúsculas, números e _)`,
      ["name"],
    );
  } else if (nameIssue) {
    issue(`${label}: nome ${RESERVED_NAME_REASON[nameIssue]}`, ["name"]);
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
    const keyIssue = pydanticFieldNameIssue(subfield.key);
    if (keyIssue === "invalid") {
      issue(
        `${label}: subcampo ${index + 1} tem chave inválida "${subfield.key}"`,
        path,
      );
    } else if (keyIssue) {
      issue(
        `${label}: subcampo "${subfield.key}" ${RESERVED_NAME_REASON[keyIssue]}`,
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
      const label = fieldLabel(index, field.name);
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

// Default de subcampo é `false` — o OPOSTO do `required` de campo
// (`resolveRequired`, acima, resolve para `true`). O gerador e o
// `FieldRenderer` sempre trataram ausente como opcional; o `SubfieldsEditor`
// cria subcampos com `required: true` explícito, então `undefined` só existe
// em dado legado (issue #491).
//
// Diferente dos resolvedores de campo acima, este NÃO aceita `null`:
// `subfieldDefSchema` declara `required` como `z.boolean().optional()`, então
// um `null` vindo do jsonb já falha o parse fail-closed. Aceitá-lo aqui
// resolveria em silêncio um payload que na verdade está corrompido.
export function resolveSubfieldRequired(value: boolean | undefined): boolean {
  return value === true;
}

// Normalizacao canonica do array de subcampos, aplicada dentro de `snapshotOf`
// (schema-utils.ts) e de `subfieldsEqual` (schema-change-diff.ts) — os dois
// pontos que decidem se dois campos sao "o mesmo campo".
//
// Sem ela, `subfields` era a unica propriedade estrutural comparada crua,
// enquanto `_extract_subfields` no backend SEMPRE grava a chave `required`:
// um subcampo legado `{key,label}` no banco e o mesmo recuperado por
// `compile_pydantic` (`{key,label,required:false}`) serializavam diferente,
// gerando bump minor sem mudanca nenhuma e conflito de merge fabricado em
// `mergeFieldProperties`, que indexa por `snapshotOf`. Mesma classe que
// `hash`, `target` e `subfield_rule` ja causaram — a quarta rodada.
// Spread em vez de projetar `{key,label,required}`: as comparacoes que chamam
// isto rodam sobre payload cru de `schema_change_log`, onde uma propriedade que
// o SubfieldDef ganhe no futuro ja aparece antes de existir aqui. Enumerar as
// chaves conhecidas descartaria essa propriedade em silencio e a mudanca dela
// sumiria do diff — e o teste "futureproof" de schema-change-diff.test.ts
// existe exatamente para barrar isso. So o default implicito e resolvido.
export function normalizeSubfields(
  subfields: SubfieldDef[] | null | undefined,
): SubfieldDef[] | null {
  if (!subfields) return null;
  return subfields.map((sf) => ({
    ...sf,
    required: resolveSubfieldRequired(sf.required),
  }));
}

export const PYDANTIC_FIELD_PROPERTY_KEYS = Object.freeze(
  Object.keys(pydanticFieldSchema.shape).sort(),
);

// Identidade de campo nova. `crypto.randomUUID` so existe em contexto seguro
// (HTTPS/localhost — mesmo motivo do fallback de `makeId` em utils.ts), mas
// aqui o fallback nao pode ser um id com prefixo arbitrario: o contrato
// (`FIELD_ID_PATTERN` acima e a CHECK constraint em `projects.pydantic_fields`)
// exige UUID, entao o fallback monta um v4 valido com `getRandomValues`, que e
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

export function parsePydanticFields(value: unknown): PydanticField[] | null {
  const result = pydanticFieldsSchema.safeParse(value);
  return result.success ? result.data : null;
}

// As regras de negócio (superRefine acima) já nascem em pt-BR e nomeadas
// ("Campo N ("nome"): ..."). As estruturais vêm com o texto padrão do Zod, em
// inglês, e por isso viram "Campo N ("nome"): formato inválido em
// <propriedade>" — ainda apontam o culpado (#502). O nome sai do valor bruto,
// porque o campo malformado não chega a ser parseado.
function describeFieldIssue(issue: z.core.$ZodIssue, value: unknown): string {
  if (issue.code === "custom") return issue.message;
  const [index, ...property] = issue.path;
  if (typeof index !== "number") return "Formato de schema inválido";
  const raw = Array.isArray(value) ? (value[index] as { name?: unknown } | null) : null;
  const label = fieldLabel(index, raw?.name);
  const where =
    issue.code === "unrecognized_keys"
      ? issue.keys.join(", ")
      : property.map(String).join(".");
  return where ? `${label}: formato inválido em ${where}` : `${label}: formato inválido`;
}

type SaveablePydanticFields =
  | { fields: PydanticField[]; errors: [] }
  | { fields: null; errors: string[] };

export function parseSaveablePydanticFields(
  value: unknown,
): SaveablePydanticFields {
  const result = saveablePydanticFieldsSchema.safeParse(value);
  return result.success
    ? { fields: result.data, errors: [] }
    : { fields: null, errors: result.error.issues.map((issue) => describeFieldIssue(issue, value)) };
}

export function validatePydanticFields(fields: PydanticField[]): string[] {
  return parseSaveablePydanticFields(fields).errors;
}
