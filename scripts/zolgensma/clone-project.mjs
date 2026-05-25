// Clona o schema (e opcionalmente os membros) de um projeto em um projeto novo.
//
// Hoje a unica forma de "reaproveitar" o schema do Zolgensma em outro projeto e
// rodar este script: o app nao tem botao "novo projeto a partir de". Issue:
// https://github.com/bdcdo/dataframeitGUI/issues/<TBD>
//
// O que e copiado:
//   - pydantic_fields, pydantic_code, pydantic_hash, prompt_template
//   - llm_provider, llm_model, llm_kwargs
//   - resolution_rule, min_responses_for_comparison, allow_researcher_review
//   - project_members (user_id, role, can_arbitrate) [com --include-members]
//
// O que NAO e copiado:
//   - documents, responses, assignments, field_reviews, schema_change_log
//   - versionamento (novo projeto comeca em 1.0.0)
//
// Uso:
//   node scripts/zolgensma/clone-project.mjs --from <uuid> --name "<nome>"                 # dry-run
//   node scripts/zolgensma/clone-project.mjs --from <uuid> --name "<nome>" --apply         # cria
//   node scripts/zolgensma/clone-project.mjs --from <uuid> --name "<nome>" --include-members --apply

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { apply: false, includeMembers: false, description: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--include-members") out.includeMembers = true;
    else if (a === "--from") out.from = args[++i];
    else if (a === "--name") out.name = args[++i];
    else if (a === "--description") out.description = args[++i];
    else throw new Error(`Argumento desconhecido: ${a}`);
  }
  if (!out.from) throw new Error("--from <uuid> obrigatorio");
  if (!out.name) throw new Error("--name <nome> obrigatorio");
  return out;
}

const opts = parseArgs();

const envPath = resolve(REPO_ROOT, "frontend", ".env.local");
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

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

async function rest(method, path, body) {
  const res = await fetch(`${URL}/rest/v1${path}`, {
    method,
    headers: { ...headers, Prefer: "return=representation" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// --- carrega o projeto origem ---------------------------------------------

const SELECT_PROJECT = [
  "id", "name", "description", "created_by",
  "pydantic_fields", "pydantic_code", "pydantic_hash",
  "prompt_template",
  "llm_provider", "llm_model", "llm_kwargs",
  "resolution_rule", "min_responses_for_comparison", "allow_researcher_review",
  "schema_version_major", "schema_version_minor", "schema_version_patch",
].join(",");

const [origem] = await rest(
  "GET",
  `/projects?id=eq.${opts.from}&select=${SELECT_PROJECT}`,
);
if (!origem) throw new Error(`Projeto origem nao encontrado: ${opts.from}`);

console.log(`Origem: ${origem.name} (${origem.id})`);
console.log(`  Versao schema: ${origem.schema_version_major}.${origem.schema_version_minor}.${origem.schema_version_patch}`);
console.log(`  Campos pydantic: ${(origem.pydantic_fields ?? []).length}`);
console.log(`  LLM: ${origem.llm_provider} / ${origem.llm_model}`);

const novo = {
  name: opts.name,
  description: opts.description ?? `${origem.description ?? ""} (schema clonado de "${origem.name}")`.trim(),
  created_by: origem.created_by, // mantem o mesmo criador
  pydantic_fields: origem.pydantic_fields,
  pydantic_code: origem.pydantic_code,
  pydantic_hash: origem.pydantic_hash,
  prompt_template: origem.prompt_template,
  llm_provider: origem.llm_provider,
  llm_model: origem.llm_model,
  llm_kwargs: origem.llm_kwargs,
  resolution_rule: origem.resolution_rule,
  min_responses_for_comparison: origem.min_responses_for_comparison,
  allow_researcher_review: origem.allow_researcher_review,
  // versionamento: zera para nao herdar historico de mudancas do origem
  schema_version_major: 1,
  schema_version_minor: 0,
  schema_version_patch: 0,
};

console.log(`\nNovo projeto:`);
console.log(`  name:        ${novo.name}`);
console.log(`  description: ${novo.description}`);
console.log(`  versao:      1.0.0 (reset)`);

let membros = [];
if (opts.includeMembers) {
  membros = await rest(
    "GET",
    `/project_members?project_id=eq.${opts.from}&select=user_id,role,can_arbitrate`,
  );
  const porRole = membros.reduce((acc, m) => {
    acc[m.role] = (acc[m.role] ?? 0) + 1;
    return acc;
  }, {});
  const arbitros = membros.filter((m) => m.can_arbitrate).length;
  console.log(`  membros:     ${membros.length} (${Object.entries(porRole).map(([k, v]) => `${k}=${v}`).join(", ")}, arbitros=${arbitros})`);
}

if (!opts.apply) {
  console.log("\n[DRY-RUN] Nada foi escrito. Rode com --apply para criar.");
  process.exit(0);
}

// --- aplica ----------------------------------------------------------------

const [criado] = await rest("POST", "/projects", novo);
console.log(`\nProjeto criado: ${criado.id}`);

if (opts.includeMembers && membros.length > 0) {
  const rows = membros.map((m) => ({
    project_id: criado.id,
    user_id: m.user_id,
    role: m.role,
    can_arbitrate: m.can_arbitrate,
  }));
  const inseridos = await rest("POST", "/project_members", rows);
  console.log(`Membros inseridos: ${inseridos.length}`);
}

console.log(`\nOK. Novo project_id: ${criado.id}`);
console.log(`URL provavel: <app>/coordinator/${criado.id}`);
