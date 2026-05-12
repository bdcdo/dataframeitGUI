// Corrige duas inconsistencias no schema do projeto Zolgensma:
//
// 1. q26_ressalva_evidencias.condition.in contem "NatJus aponta incerteza",
//    valor que nao existe em q25_conclusao_evidencias.options. Esse valor
//    existe em q20_metodologia_evidencia (provavel erro de configuracao).
//    Solucao: remover "NatJus aponta incerteza" da condicao do q26.
//
// 2. q7_idade_paciente nao tem options. Adicionar "Nao informada" como
//    sentinel value (mesmo padrao de q2/q3/q6).
//
// Uso:
//   node frontend/scripts/fix-zolgensma-schema-2026-05-12.mjs           # dry-run
//   node frontend/scripts/fix-zolgensma-schema-2026-05-12.mjs --apply   # persiste

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

const envPath = resolve(__dirname, "..", ".env.local");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) throw new Error("URL/KEY nao encontrados em .env.local");

const PROJECT_ID = "0c6394da-dd2e-4ac0-af83-a107fae37ad4";
const CHANGED_BY = "234c08f3-b4eb-41fc-8b99-5b1419f4f7b0"; // bruno

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function rest(method, path, body) {
  const res = await fetch(`${URL}/rest/v1${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// ---- Port de generatePydanticCode (frontend/src/lib/schema-utils.ts) -------

function escapeString(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function subfieldClassName(name) {
  return `_${name}_fields`;
}

function baseAnnotation(field) {
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

function fieldAnnotation(field) {
  const base = baseAnnotation(field);
  if (field.condition) return `Optional[${base}]`;
  return base;
}

function pythonScalar(v) {
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "None";
  return `"${escapeString(v)}"`;
}

function pythonScalarList(values) {
  return `[${values.map(pythonScalar).join(", ")}]`;
}

function conditionToPython(c) {
  const parts = [`"field": "${escapeString(c.field)}"`];
  if ("equals" in c) parts.push(`"equals": ${pythonScalar(c.equals)}`);
  else if ("not_equals" in c) parts.push(`"not_equals": ${pythonScalar(c.not_equals)}`);
  else if ("in" in c) parts.push(`"in": ${pythonScalarList(c.in)}`);
  else if ("not_in" in c) parts.push(`"not_in": ${pythonScalarList(c.not_in)}`);
  else if ("exists" in c) parts.push(`"exists": ${c.exists ? "True" : "False"}`);
  return `{${parts.join(", ")}}`;
}

function fieldExtra(field) {
  const extras = [];
  if (field.target && field.target !== "all") {
    extras.push(`"target": "${field.target}"`);
  }
  if (field.type === "date") {
    extras.push(`"field_type": "date"`);
    if (field.options && field.options.length > 0) {
      const opts = field.options.map((o) => `"${escapeString(o)}"`).join(", ");
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
  if (field.help_text && field.help_text.trim()) {
    extras.push(`"help_text": "${escapeString(field.help_text.trim())}"`);
  }
  if (field.condition) {
    extras.push(`"condition": ${conditionToPython(field.condition)}`);
  }
  if (extras.length === 0) return "";
  return `, json_schema_extra={${extras.join(", ")}}`;
}

function generatePydanticCode(fields, modelName = "Analysis") {
  const lines = [
    "from pydantic import BaseModel, Field",
    "from typing import Literal, Optional",
    "",
  ];

  for (const field of fields) {
    if (field.subfields && field.subfields.length > 0) {
      lines.push("");
      lines.push(`class ${subfieldClassName(field.name)}(BaseModel):`);
      for (const sf of field.subfields) {
        const ann =
          sf.required && field.subfield_rule !== "at_least_one"
            ? "str"
            : "Optional[str]";
        lines.push(
          `    ${sf.key}: ${ann} = Field(${
            ann === "Optional[str]" ? "default=None, " : ""
          }description="${escapeString(sf.label)}")`,
        );
      }
    }
  }

  lines.push("");
  lines.push(`class ${modelName}(BaseModel):`);
  if (fields.length === 0) lines.push("    pass");

  for (const field of fields) {
    const ann = fieldAnnotation(field);
    let desc = escapeString(field.description);
    if (field.type === "date") {
      desc += ". Formato: DD/MM/AAAA (use XX para partes desconhecidas)";
    }
    if (field.type === "date" && field.options && field.options.length > 0) {
      const sentinelList = field.options
        .map((o) => `\\"${escapeString(o)}\\"`)
        .join(", ");
      desc += `. Caso não seja possível informar a data, usar um dos seguintes valores: ${sentinelList}`;
    }
    if (field.help_text && field.help_text.trim()) {
      desc += `. Instrucoes: ${escapeString(field.help_text.trim())}`;
    }
    const extra = fieldExtra(field);
    const defaultPart = field.condition ? "default=None, " : "";
    lines.push(
      `    ${field.name}: ${ann} = Field(${defaultPart}description="${desc}"${extra})`,
    );
  }

  return lines.join("\n") + "\n";
}

// ---- Helpers de hash ------------------------------------------------------

function pythonListRepr(items) {
  return `[${items.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(", ")}]`;
}

function computeFieldHash(name, type, options, description) {
  const optionsPart = options ? pythonListRepr([...options].sort()) : "";
  const content = `${name}|${type}|${optionsPart}|${description}`;
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
}

// ---- Main -----------------------------------------------------------------

function snapshotOf(field) {
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
  };
}

const [project] = await rest(
  "GET",
  `/projects?id=eq.${PROJECT_ID}&select=name,pydantic_fields,pydantic_code,schema_version_major,schema_version_minor,schema_version_patch`,
);
if (!project) throw new Error("projeto nao encontrado");

console.log(`Projeto: ${project.name}`);
console.log(
  `Versao atual: ${project.schema_version_major}.${project.schema_version_minor}.${project.schema_version_patch}`,
);

const oldFields = structuredClone(project.pydantic_fields);
const newFields = structuredClone(project.pydantic_fields);

const q7 = newFields.find((f) => f.name === "q7_idade_paciente");
const q26 = newFields.find((f) => f.name === "q26_ressalva_evidencias");
if (!q7) throw new Error("q7_idade_paciente nao encontrado");
if (!q26) throw new Error("q26_ressalva_evidencias nao encontrado");

const oldQ7 = oldFields.find((f) => f.name === "q7_idade_paciente");
const oldQ26 = oldFields.find((f) => f.name === "q26_ressalva_evidencias");

// Fix 1: remover "NatJus aponta incerteza" da condition do q26
const SENTINEL = "NatJus aponta incerteza";
if (
  q26.condition &&
  Array.isArray(q26.condition.in) &&
  q26.condition.in.includes(SENTINEL)
) {
  q26.condition = {
    ...q26.condition,
    in: q26.condition.in.filter((v) => v !== SENTINEL),
  };
  console.log(
    `\n[q26] condition.in: ${JSON.stringify(oldQ26.condition.in)} -> ${JSON.stringify(q26.condition.in)}`,
  );
} else {
  console.log(`\n[q26] sem mudanca (condition.in nao contem "${SENTINEL}")`);
}

// Fix 2: adicionar "Nao informada" em options de q7
const NAO_INFORMADA = "Não informada";
const currentOpts = Array.isArray(q7.options) ? q7.options : [];
if (!currentOpts.includes(NAO_INFORMADA)) {
  q7.options = [...currentOpts, NAO_INFORMADA];
  console.log(
    `[q7]  options: ${JSON.stringify(oldQ7.options ?? null)} -> ${JSON.stringify(q7.options)}`,
  );
} else {
  console.log(`[q7]  sem mudanca (options ja contem "${NAO_INFORMADA}")`);
}

// Regerar pydantic_code
const newCode = generatePydanticCode(newFields);
const codeChanged = newCode !== project.pydantic_code;

// Calcular log entries (formato schema_change_log: before_value/after_value)
const logEntries = [];
function maybeLog(oldF, newF) {
  const before = snapshotOf(oldF);
  const after = snapshotOf(newF);
  const diffs = [];
  const fieldsToCompare = ["options", "condition"];
  for (const k of fieldsToCompare) {
    if (JSON.stringify(oldF[k] ?? null) !== JSON.stringify(newF[k] ?? null)) {
      diffs.push(k === "options" ? "opções" : "condição");
    }
  }
  if (diffs.length > 0) {
    logEntries.push({
      field_name: newF.name,
      change_summary: diffs.join(", "),
      before_value: before,
      after_value: after,
    });
  }
}
maybeLog(oldQ7, q7);
maybeLog(oldQ26, q26);

if (logEntries.length === 0) {
  console.log("\nNada a fazer.");
  process.exit(0);
}

// Versionamento: opcoes/condicao sao mudancas estruturais -> MINOR bump
const bumped = {
  major: project.schema_version_major,
  minor: project.schema_version_minor + 1,
  patch: 0,
};
console.log(
  `\nNova versao: ${bumped.major}.${bumped.minor}.${bumped.patch} (bump MINOR)`,
);
console.log(`pydantic_code mudou: ${codeChanged ? "sim" : "nao"}`);
console.log(`\nLog entries (${logEntries.length}):`);
for (const e of logEntries) {
  console.log(`  - ${e.field_name}: ${e.change_summary}`);
}

if (!APPLY) {
  console.log("\nDRY-RUN. Rode com --apply para persistir.");
  process.exit(0);
}

// Apply: PATCH project + INSERT schema_change_log
const fieldsWithHash = newFields.map((f) => ({
  ...f,
  hash: computeFieldHash(
    f.name,
    f.type,
    f.options ?? null,
    f.description ?? "",
  ),
}));

await rest("PATCH", `/projects?id=eq.${PROJECT_ID}`, {
  pydantic_fields: fieldsWithHash,
  pydantic_code: newCode,
  schema_version_major: bumped.major,
  schema_version_minor: bumped.minor,
  schema_version_patch: bumped.patch,
});
console.log("\nProjeto atualizado.");

await rest(
  "POST",
  `/schema_change_log`,
  logEntries.map((e) => ({
    project_id: PROJECT_ID,
    changed_by: CHANGED_BY,
    change_type: "minor",
    version_major: bumped.major,
    version_minor: bumped.minor,
    version_patch: bumped.patch,
    ...e,
  })),
);
console.log(`schema_change_log: ${logEntries.length} entrada(s) inseridas.`);
console.log("\nOK.");
