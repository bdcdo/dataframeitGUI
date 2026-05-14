import type {
  ConditionScalar,
  FieldCondition,
  PydanticField,
} from "@/lib/types";

// ---------- Geração de código Pydantic (pure, client-safe) ----------

function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function subfieldClassName(fieldName: string): string {
  return `_${fieldName}_fields`;
}

function baseAnnotation(field: PydanticField): string {
  if (field.type === "single" && field.options) {
    return `Literal[${field.options.map((o) => `"${escapeString(o)}"`).join(", ")}]`;
  }
  if (field.type === "multi" && field.options) {
    return `list[Literal[${field.options.map((o) => `"${escapeString(o)}"`).join(", ")}]]`;
  }
  if (field.subfields && field.subfields.length > 0) {
    return subfieldClassName(field.name);
  }
  return "str";
}

function fieldAnnotation(field: PydanticField): string {
  const base = baseAnnotation(field);
  if (field.condition) return `Optional[${base}]`;
  return base;
}

function pythonScalar(value: ConditionScalar): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "None";
  return `"${escapeString(value)}"`;
}

function pythonScalarList(values: ConditionScalar[]): string {
  return `[${values.map(pythonScalar).join(", ")}]`;
}

function conditionToPython(condition: FieldCondition): string {
  const parts: string[] = [`"field": "${escapeString(condition.field)}"`];
  if ("equals" in condition) {
    parts.push(`"equals": ${pythonScalar(condition.equals)}`);
  } else if ("not_equals" in condition) {
    parts.push(`"not_equals": ${pythonScalar(condition.not_equals)}`);
  } else if ("in" in condition) {
    parts.push(`"in": ${pythonScalarList(condition.in)}`);
  } else if ("not_in" in condition) {
    parts.push(`"not_in": ${pythonScalarList(condition.not_in)}`);
  } else if ("exists" in condition) {
    parts.push(`"exists": ${condition.exists ? "True" : "False"}`);
  }
  return `{${parts.join(", ")}}`;
}

function fieldExtra(field: PydanticField): string {
  const extras: string[] = [];
  if (field.target && field.target !== "all") {
    extras.push(`"target": "${field.target}"`);
  }
  if (field.type === "date") {
    extras.push(`"field_type": "date"`);
    // Date fields carry options as sentinel values (ex: "Não identificável")
    // rendered alongside the date picker. They must be carried in
    // json_schema_extra because the annotation itself is `str`, not Literal.
    if (field.options && field.options.length > 0) {
      const opts = field.options
        .map((o) => `"${escapeString(o)}"`)
        .join(", ");
      extras.push(`"options": [${opts}]`);
    }
  }
  if ((field.type === "single" || field.type === "multi") && field.allow_other) {
    extras.push(`"allowOther": True`);
  }
  if (
    field.subfields &&
    field.subfields.length > 0 &&
    field.subfield_rule &&
    field.subfield_rule !== "all"
  ) {
    extras.push(`"subfield_rule": "${field.subfield_rule}"`);
  }
  if (field.help_text?.trim()) {
    extras.push(`"help_text": "${escapeString(field.help_text.trim())}"`);
  }
  if (field.condition) {
    extras.push(`"condition": ${conditionToPython(field.condition)}`);
  }
  if (field.justification_prompt?.trim()) {
    extras.push(
      `"justification_prompt": "${escapeString(field.justification_prompt.trim())}"`,
    );
  }
  if (extras.length === 0) return "";
  return `, json_schema_extra={${extras.join(", ")}}`;
}

export function generatePydanticCode(
  fields: PydanticField[],
  modelName = "Analysis"
): string {
  const lines = [
    "from pydantic import BaseModel, Field",
    "from typing import Literal, Optional",
    "",
  ];

  // Generate nested BaseModel classes for composite text fields.
  // Note: fields with target="none" are emitted in the Pydantic code
  // (to preserve round-trip with pydantic_code as source of truth) but
  // are filtered out in the backend before the LLM run and in the UI
  // renderers that show fields to humans.
  for (const field of fields) {
    if (field.subfields && field.subfields.length > 0) {
      lines.push("");
      lines.push(`class ${subfieldClassName(field.name)}(BaseModel):`);
      for (const sf of field.subfields) {
        const ann = sf.required && field.subfield_rule !== "at_least_one"
          ? "str"
          : "Optional[str]";
        lines.push(
          `    ${sf.key}: ${ann} = Field(${ann === "Optional[str]" ? "default=None, " : ""}description="${escapeString(sf.label)}")`
        );
      }
    }
  }

  lines.push("");
  lines.push(`class ${modelName}(BaseModel):`);

  if (fields.length === 0) {
    lines.push("    pass");
  }

  for (const field of fields) {
    const ann = fieldAnnotation(field);
    let desc = escapeString(field.description);
    if (field.type === "date") {
      desc += ". Formato: DD/MM/AAAA (use XX para partes desconhecidas)";
    }
    if (
      field.type === "date" &&
      field.options &&
      field.options.length > 0
    ) {
      const sentinelList = field.options
        .map((o) => `\\"${escapeString(o)}\\"`)
        .join(", ");
      desc += `. Caso não seja possível informar a data, usar um dos seguintes valores: ${sentinelList}`;
    }
    if (field.help_text?.trim()) {
      desc += `. Instrucoes: ${escapeString(field.help_text.trim())}`;
    }
    const extra = fieldExtra(field);
    // Optional[...] sem default=None continua required no Pydantic v2; o
    // default=None garante que o código gerado seja utilizável standalone
    // e compatível com LLM que omita o campo (Optional).
    const defaultPart = field.condition ? "default=None, " : "";
    lines.push(
      `    ${field.name}: ${ann} = Field(${defaultPart}description="${desc}"${extra})`
    );
  }

  return lines.join("\n") + "\n";
}

// ---------- Validação client-side ----------

const PYTHON_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function validateGUIFields(fields: PydanticField[]): string[] {
  const errors: string[] = [];

  if (fields.length === 0) {
    errors.push("Adicione pelo menos um campo.");
    return errors;
  }

  const names = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const label = `Campo ${i + 1}`;

    if (!f.name || !PYTHON_IDENTIFIER.test(f.name)) {
      errors.push(
        `${label}: nome inválido "${f.name}" (use letras minúsculas, números e _)`
      );
    }
    if (names.has(f.name)) {
      errors.push(`${label}: nome "${f.name}" duplicado`);
    }
    names.add(f.name);

    if (!f.description.trim()) {
      errors.push(`${label}: descrição não pode ser vazia`);
    }

    if (f.subfields && f.subfields.length > 0) {
      const sfKeys = new Set<string>();
      for (let j = 0; j < f.subfields.length; j++) {
        const sf = f.subfields[j];
        if (!sf.key || !PYTHON_IDENTIFIER.test(sf.key)) {
          errors.push(
            `${label}: subcampo ${j + 1} tem chave inválida "${sf.key}"`
          );
        }
        if (sfKeys.has(sf.key)) {
          errors.push(`${label}: subcampo "${sf.key}" duplicado`);
        }
        sfKeys.add(sf.key);
        if (!sf.label.trim()) {
          errors.push(`${label}: subcampo ${j + 1} tem label vazio`);
        }
      }
    }

    if (
      (f.type === "single" || f.type === "multi") &&
      (!f.options || f.options.length === 0)
    ) {
      errors.push(
        `${label}: campo de escolha precisa de pelo menos uma opção`
      );
    }

    if (f.options) {
      for (let j = 0; j < f.options.length; j++) {
        if (!f.options[j].trim()) {
          errors.push(`${label}: opção ${j + 1} está vazia`);
        }
      }
    }

    if (f.condition) {
      const trigger = f.condition.field;
      if (!trigger) {
        errors.push(`${label}: condição sem campo gatilho`);
      } else if (trigger === f.name) {
        errors.push(`${label}: condição não pode referenciar o próprio campo`);
      } else {
        const earlier = fields.slice(0, i);
        const triggerField = earlier.find((g) => g.name === trigger);
        if (!triggerField) {
          errors.push(
            `${label}: campo gatilho "${trigger}" inexistente ou posterior ao campo condicional`,
          );
        } else if ("equals" in f.condition || "not_equals" in f.condition) {
          const val =
            "equals" in f.condition
              ? f.condition.equals
              : f.condition.not_equals;
          if (
            triggerField.options &&
            typeof val === "string" &&
            !triggerField.options.includes(val)
          ) {
            errors.push(
              `${label}: valor "${val}" não está nas opções de "${trigger}"`,
            );
          }
        } else if ("in" in f.condition || "not_in" in f.condition) {
          const vals =
            "in" in f.condition ? f.condition.in : f.condition.not_in;
          if (!Array.isArray(vals) || vals.length === 0) {
            errors.push(`${label}: lista de valores da condição vazia`);
          } else if (triggerField.options) {
            for (const v of vals) {
              if (typeof v === "string" && !triggerField.options.includes(v)) {
                errors.push(
                  `${label}: valor "${v}" não está nas opções de "${trigger}"`,
                );
              }
            }
          }
        }
      }
    }
  }

  return errors;
}

// ---------- Detecção de conflito de condition ao remover opção ----------

export type ConditionConflict = {
  fieldName: string;
  fieldLabel: string;
  conditionKey: "equals" | "not_equals" | "in" | "not_in";
};

// Retorna os campos que referenciam `removedOption` em suas condições, quando
// a condition tem `field === triggerFieldName`. Usado para avisar o usuário
// (e oferecer auto-correção) antes de remover uma opção em uso.
export function findConditionConflicts(
  fields: PydanticField[],
  triggerFieldName: string,
  removedOption: string,
): ConditionConflict[] {
  const conflicts: ConditionConflict[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const c = f.condition;
    if (!c || c.field !== triggerFieldName) continue;

    let conditionKey: ConditionConflict["conditionKey"] | null = null;
    if ("equals" in c && c.equals === removedOption) conditionKey = "equals";
    else if ("not_equals" in c && c.not_equals === removedOption)
      conditionKey = "not_equals";
    else if ("in" in c && Array.isArray(c.in) && c.in.includes(removedOption))
      conditionKey = "in";
    else if (
      "not_in" in c &&
      Array.isArray(c.not_in) &&
      c.not_in.includes(removedOption)
    )
      conditionKey = "not_in";

    if (conditionKey) {
      conflicts.push({
        fieldName: f.name,
        fieldLabel: `Campo ${i + 1}`,
        conditionKey,
      });
    }
  }
  return conflicts;
}

// Remove `removedOption` das conditions afetadas. Se a condition usa equals/
// not_equals com o valor removido, apaga a condition inteira (não há valor
// alternativo); se usa in/not_in, filtra o array (e remove a condition se
// ficar vazio).
export function stripOptionFromConditions(
  fields: PydanticField[],
  triggerFieldName: string,
  removedOption: string,
): PydanticField[] {
  return fields.map((f) => {
    const c = f.condition;
    if (!c || c.field !== triggerFieldName) return f;

    if ("equals" in c && c.equals === removedOption) {
      const next = { ...f };
      delete next.condition;
      return next;
    }
    if ("not_equals" in c && c.not_equals === removedOption) {
      const next = { ...f };
      delete next.condition;
      return next;
    }
    if ("in" in c && Array.isArray(c.in) && c.in.includes(removedOption)) {
      const filtered = c.in.filter((v) => v !== removedOption);
      if (filtered.length === 0) {
        const next = { ...f };
        delete next.condition;
        return next;
      }
      return { ...f, condition: { ...c, in: filtered } };
    }
    if (
      "not_in" in c &&
      Array.isArray(c.not_in) &&
      c.not_in.includes(removedOption)
    ) {
      const filtered = c.not_in.filter((v) => v !== removedOption);
      if (filtered.length === 0) {
        const next = { ...f };
        delete next.condition;
        return next;
      }
      return { ...f, condition: { ...c, not_in: filtered } };
    }
    return f;
  });
}

// ---------- SHA-256 (pure, client-safe) ----------
// Implementação própria em TS puro para manter este módulo client-safe: o
// `crypto` do Node não pode ser importado aqui porque schema-utils.ts é
// bundlado em componentes client (FieldCard, EditFieldDialog). O resultado
// hex bate byte-a-byte com `hashlib.sha256` do Python e com
// `crypto.createHash("sha256")` do Node.

function sha256Hex(input: string): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);

  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const numBlocks = Math.ceil((bytes.length + 9) / 64);
  const total = numBlocks * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  // length em bits como big-endian de 64 bits (bitLen cabe em 53 bits)
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(total - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let block = 0; block < numBlocks; block++) {
    const off = block * 64;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 =
        rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = H[0],
      b = H[1],
      c = H[2],
      d = H[3],
      e = H[4],
      f = H[5],
      g = H[6],
      h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0;
    H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += (H[i] >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
}

// ---------- Versionamento + auditoria de schema (pure, client-safe) ----------
// Primitivas extraídas de actions/schema.ts (#63) para que scripts fora do
// Next runtime importem a lógica canônica em vez de replicá-la. Ao adicionar
// uma propriedade nova a PydanticField, atualize aqui:
//   - snapshotOf (serialização para schema_change_log)
//   - classifyChange (estrutural=minor vs textual=patch)
//   - diffFields (entradas de auditoria por campo)
//   - fieldDiffIsStructural (reclassificação no backfill)
// junto com generatePydanticCode (acima) e compile_pydantic (backend).

function pythonListRepr(arr: string[]): string {
  return "[" + arr.map((s) => `'${s}'`).join(", ") + "]";
}

// Hash estável por campo — espelha _field_hash do backend. Exclui `target`,
// `condition`, `help_text` (carregados estruturalmente) de propósito: mudá-los
// não invalida respostas já coletadas.
export function computeFieldHash(
  name: string,
  type: string,
  options: string[] | null,
  description: string,
): string {
  const optionsPart = options ? pythonListRepr([...options].sort()) : "";
  const content = `${name}|${type}|${optionsPart}|${description}`;
  return sha256Hex(content).slice(0, 12);
}

export type ChangeType = "major" | "minor" | "patch";

// Classifica uma edição de schema:
// - PATCH: mudanças apenas em description/help_text/justification_prompt ou
//   reordenação (sem mudança estrutural)
// - MINOR: adicionar/remover campo, adicionar/remover opção, mudar
//   type/target/required/subfields/condition
// - Retorna null quando não há mudança alguma.
export function classifyChange(
  oldFields: PydanticField[],
  newFields: PydanticField[],
): ChangeType | null {
  const oldNames = new Set(oldFields.map((f) => f.name));
  const newNames = new Set(newFields.map((f) => f.name));

  const addedOrRemoved =
    newFields.some((f) => !oldNames.has(f.name)) ||
    oldFields.some((f) => !newNames.has(f.name));

  if (addedOrRemoved) return "minor";

  let hasStructural = false;
  let hasTextual = false;

  const oldMap = new Map(oldFields.map((f) => [f.name, f]));
  for (const n of newFields) {
    const o = oldMap.get(n.name);
    if (!o) continue;

    if (o.type !== n.type) hasStructural = true;
    if ((o.target ?? "all") !== (n.target ?? "all")) hasStructural = true;
    if ((o.required ?? true) !== (n.required ?? true)) hasStructural = true;
    if ((o.subfield_rule ?? null) !== (n.subfield_rule ?? null)) hasStructural = true;
    if ((o.allow_other ?? false) !== (n.allow_other ?? false)) hasStructural = true;
    if (JSON.stringify(o.subfields ?? null) !== JSON.stringify(n.subfields ?? null)) {
      hasStructural = true;
    }
    if (JSON.stringify(o.condition ?? null) !== JSON.stringify(n.condition ?? null)) {
      hasStructural = true;
    }

    const optsOld = o.options ?? [];
    const optsNew = n.options ?? [];
    const setOld = new Set(optsOld);
    const setNew = new Set(optsNew);
    const sameSet =
      setOld.size === setNew.size && [...setOld].every((x) => setNew.has(x));
    if (!sameSet) {
      hasStructural = true;
    } else if (optsOld.length !== optsNew.length) {
      hasStructural = true;
    } else {
      for (let i = 0; i < optsOld.length; i++) {
        if (optsOld[i] !== optsNew[i]) {
          hasTextual = true;
          break;
        }
      }
    }

    if (o.description !== n.description) hasTextual = true;
    if ((o.help_text || "") !== (n.help_text || "")) hasTextual = true;
    if ((o.justification_prompt || "") !== (n.justification_prompt || "")) {
      hasTextual = true;
    }
  }

  // Reordenação da lista de campos conta como PATCH
  if (!hasStructural && !hasTextual) {
    for (let i = 0; i < newFields.length; i++) {
      if (newFields[i].name !== oldFields[i]?.name) {
        hasTextual = true;
        break;
      }
    }
  }

  if (hasStructural) return "minor";
  if (hasTextual) return "patch";
  return null;
}

export function bumpVersion(
  current: { major: number; minor: number; patch: number },
  type: ChangeType,
): { major: number; minor: number; patch: number } {
  if (type === "major") {
    return { major: current.major + 1, minor: 0, patch: 0 };
  }
  if (type === "minor") {
    return { major: current.major, minor: current.minor + 1, patch: 0 };
  }
  return { major: current.major, minor: current.minor, patch: current.patch + 1 };
}

// Serializa um PydanticField para gravar em
// schema_change_log.before_value / after_value.
export function snapshotOf(field: PydanticField): Record<string, unknown> {
  return {
    name: field.name,
    type: field.type,
    description: field.description,
    help_text: field.help_text ?? null,
    options: field.options ?? null,
    target: field.target ?? null,
    required: field.required ?? null,
    subfields: field.subfields ?? null,
    subfield_rule: field.subfield_rule ?? null,
    allow_other: field.allow_other ?? null,
    condition: field.condition ?? null,
    justification_prompt: field.justification_prompt ?? null,
  };
}

// Classifica um diff de schema_change_log (before/after por campo) como
// estrutural (minor) ou textual (patch). Add/remove são sempre estruturais.
// description / help_text / justification_prompt são textuais (patch).
export function fieldDiffIsStructural(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  if (Object.keys(before).length === 0 || Object.keys(after).length === 0) return true;

  for (const k of ["type", "target", "required", "subfield_rule", "allow_other"]) {
    if (before[k] !== undefined || after[k] !== undefined) return true;
  }

  if (before.subfields !== undefined || after.subfields !== undefined) {
    if (JSON.stringify(before.subfields ?? null) !== JSON.stringify(after.subfields ?? null)) {
      return true;
    }
  }

  if (before.condition !== undefined || after.condition !== undefined) {
    if (JSON.stringify(before.condition ?? null) !== JSON.stringify(after.condition ?? null)) {
      return true;
    }
  }

  const bOpts = before.options;
  const aOpts = after.options;
  if (bOpts !== undefined || aOpts !== undefined) {
    const bArr = Array.isArray(bOpts) ? (bOpts as unknown[]) : [];
    const aArr = Array.isArray(aOpts) ? (aOpts as unknown[]) : [];
    const bSet = new Set(bArr);
    const aSet = new Set(aArr);
    const sameSet = bSet.size === aSet.size && [...bSet].every((x) => aSet.has(x));
    if (!sameSet) return true;
  }
  return false;
}

export interface SchemaLogEntry {
  field_name: string;
  change_summary: string;
  before_value: Record<string, unknown>;
  after_value: Record<string, unknown>;
}

// Monta as entradas de auditoria por campo (added / removed / modified)
// comparando o estado antigo e o novo do schema.
export function diffFields(
  oldFields: PydanticField[],
  newFields: PydanticField[],
): SchemaLogEntry[] {
  const oldMap = new Map(oldFields.map((f) => [f.name, f]));
  const newMap = new Map(newFields.map((f) => [f.name, f]));
  const logEntries: SchemaLogEntry[] = [];

  // Campos adicionados: sem entry anterior
  for (const f of newFields) {
    if (oldMap.has(f.name)) continue;
    logEntries.push({
      field_name: f.name,
      change_summary: "campo adicionado",
      before_value: {},
      after_value: snapshotOf(f),
    });
  }

  // Campos removidos: sem entry atual
  for (const o of oldFields) {
    if (newMap.has(o.name)) continue;
    logEntries.push({
      field_name: o.name,
      change_summary: "campo removido",
      before_value: snapshotOf(o),
      after_value: {},
    });
  }

  // Campos modificados: compara atributo por atributo
  for (const f of newFields) {
    const old = oldMap.get(f.name);
    if (!old) continue;
    const diffs: string[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (old.description !== f.description) {
      diffs.push("descrição");
      before.description = old.description;
      after.description = f.description;
    }
    if ((old.help_text || "") !== (f.help_text || "")) {
      diffs.push("instruções");
      before.help_text = old.help_text || null;
      after.help_text = f.help_text || null;
    }
    const oldOpts = JSON.stringify(old.options ?? null);
    const newOpts = JSON.stringify(f.options ?? null);
    if (oldOpts !== newOpts) {
      diffs.push(f.type === "text" ? "respostas padronizadas" : "opções");
      before.options = old.options;
      after.options = f.options;
    }
    if (old.type !== f.type) {
      diffs.push("tipo");
      before.type = old.type;
      after.type = f.type;
    }
    if ((old.target ?? "all") !== (f.target ?? "all")) {
      diffs.push("alvo");
      before.target = old.target ?? null;
      after.target = f.target ?? null;
    }
    if ((old.required ?? true) !== (f.required ?? true)) {
      diffs.push("obrigatório");
      before.required = old.required ?? null;
      after.required = f.required ?? null;
    }
    if ((old.subfield_rule ?? null) !== (f.subfield_rule ?? null)) {
      diffs.push("regra de subcampos");
      before.subfield_rule = old.subfield_rule ?? null;
      after.subfield_rule = f.subfield_rule ?? null;
    }
    if ((old.allow_other ?? false) !== (f.allow_other ?? false)) {
      diffs.push("permite outro");
      before.allow_other = old.allow_other ?? false;
      after.allow_other = f.allow_other ?? false;
    }
    const oldSubs = JSON.stringify(old.subfields ?? null);
    const newSubs = JSON.stringify(f.subfields ?? null);
    if (oldSubs !== newSubs) {
      diffs.push("subcampos");
      before.subfields = old.subfields ?? null;
      after.subfields = f.subfields ?? null;
    }
    const oldCond = JSON.stringify(old.condition ?? null);
    const newCond = JSON.stringify(f.condition ?? null);
    if (oldCond !== newCond) {
      diffs.push("condição");
      before.condition = old.condition ?? null;
      after.condition = f.condition ?? null;
    }
    if ((old.justification_prompt || "") !== (f.justification_prompt || "")) {
      diffs.push("prompt de justificativa");
      before.justification_prompt = old.justification_prompt || null;
      after.justification_prompt = f.justification_prompt || null;
    }

    if (diffs.length > 0) {
      logEntries.push({
        field_name: f.name,
        change_summary: diffs.join(", "),
        before_value: before,
        after_value: after,
      });
    }
  }

  return logEntries;
}
